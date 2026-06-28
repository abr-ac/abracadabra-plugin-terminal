/**
 * The terminal serverRunner — `requires: ['process']`, so only a process-capable
 * host (Electron-main utilityProcess or a headless Node daemon) runs it; a Nitro
 * host that can't exec skips it. Watches the page doc's session map, claims
 * `requested` sessions, spawns a PTY via the host-injected `process` capability,
 * and bridges it over the hybrid transport.
 *
 * Proven headless in abracadabra-runner-host before landing here.
 */
import type {
  ServerRunnerDefinition,
  ServerRunnerContextBase,
  AbraYDoc,
} from '@abraca/plugin'
import type * as Y from 'yjs'
import {
  SESSIONS_KEY, TTY_FIELD, TERMHOST_FIELD, CONTROL_KEY,
  FRAME_WINDOW, MAX_SCROLLBACK, HEARTBEAT_MS,
  bytesToLatin1, setMeta,
  type SessionSpec, type ControlState,
} from './session.ts'

/** Minimal awareness shape the host's provider exposes. */
interface AwarenessLike { setLocalStateField(field: string, value: unknown): void }
/** A synced doc handle the host returns from `openDoc`. */
interface OpenedDoc { doc: AbraYDoc; provider: { awareness: AwarenessLike | null } }

/**
 * Context a process-capable host provides. Extends the shared base with the
 * `openDoc` host helper (to open session subdocs) and the host's human-readable
 * `identityName` (advertised to viewers as the host label). `host.process` is
 * guaranteed present because the runner declared `requires: ['process']`.
 */
export interface TerminalRunnerCtx extends ServerRunnerContextBase {
  openDoc(id: string): Promise<OpenedDoc>
  identityName?: string
}

/** Login shell of the host machine — the runner's default when the spec names no command. */
const defaultCommand = (): string[] => [process.env.SHELL || 'bash', '-l']

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createTerminalRunner(opts: { hostId?: string } = {}): ServerRunnerDefinition<TerminalRunnerCtx> {
  const hostId = opts.hostId || 'host-1'
  return {
    name: 'terminal',
    requires: ['process'],
    async start(ctx) {
      const hostName = ctx.identityName || hostId
      const page = ctx.rootDoc as unknown as Y.Doc
      const sessions = page.getMap<SessionSpec>(SESSIONS_KEY)
      const active = new Map<string, { cleanup: (() => void) | null }>()

      const scan = (): void => {
        for (const id of [...sessions.keys()]) {
          const s = sessions.get(id)
          if (!s || active.has(id)) continue
          if (s.status === 'requested' && (!s.host || s.host === hostId)) {
            active.set(id, { cleanup: null })
            sessions.set(id, { ...s, status: 'starting', host: hostId }) // claim
            void bridgeSession(ctx, hostId, hostName, sessions, id, s, active).catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : String(e)
              sessions.set(id, { ...(sessions.get(id) as SessionSpec), status: 'error', error: msg })
              active.delete(id)
            })
          }
        }
      }

      sessions.observe(scan)
      scan()
      return () => { for (const [, h] of active) h.cleanup?.() }
    },
  }
}

async function bridgeSession(
  ctx: TerminalRunnerCtx,
  hostId: string,
  hostName: string,
  sessions: Y.Map<SessionSpec>,
  id: string,
  spec: SessionSpec,
  active: Map<string, { cleanup: (() => void) | null }>,
): Promise<void> {
  const process = ctx.host?.process
  if (!process) throw new Error('host did not inject the process capability')

  const opened = await ctx.openDoc(id)

  // Claim-race guard: two hosts can both observe `requested` and optimistically
  // claim before either's write propagates. openDoc already cost a sync RTT;
  // give it a beat more, then bail if we no longer own the claim (LWW winner runs it).
  await sleep(120)
  if (sessions.get(id)?.host !== hostId) { active.delete(id); return }

  const sdoc = opened.doc as unknown as Y.Doc
  const aw = opened.provider.awareness
  const cmd = Array.isArray(spec.command) && spec.command.length ? spec.command : defaultCommand()
  let cols = spec.cols || 80
  let rows = spec.rows || 24

  const pty = process.spawn(cmd[0]!, cmd.slice(1), { cols, rows })
  setMeta(sdoc, { status: 'running', host: hostId, hostName, pid: pty.pid ?? null, cols, rows, startedBy: spec.startedBy ?? null })
  sessions.set(id, { ...(sessions.get(id) as SessionSpec), status: 'running', host: hostId })

  // ── LIVENESS: heartbeat on awareness so viewers can tell a live host from an
  //    orphaned `running` session (output frames already imply liveness; this
  //    covers idle gaps). Refreshed immediately, then every HEARTBEAT_MS. ──
  const beat = (): void => aw?.setLocalStateField(TERMHOST_FIELD, { hostId, name: hostName, t: Date.now() })
  beat()
  const beatTimer = setInterval(beat, HEARTBEAT_MS)

  // ── OUTPUT -> awareness (sliding window of seq frames) + scrollback accumulate ──
  let outSeq = 0
  let scroll = ''
  let pending: Uint8Array[] = []
  let plen = 0
  const frames: { seq: number; d: string }[] = []
  const flush = (): void => {
    if (!plen) return
    const buf = new Uint8Array(plen)
    let off = 0
    for (const c of pending) { buf.set(c, off); off += c.length }
    pending = []; plen = 0
    const d = bytesToLatin1(buf)
    outSeq++
    frames.push({ seq: outSeq, d })
    while (frames.length > FRAME_WINDOW) frames.shift()
    aw?.setLocalStateField(TTY_FIELD, { host: hostId, seq: outSeq, frames: frames.slice() })
    scroll += d
    if (scroll.length > MAX_SCROLLBACK) scroll = scroll.slice(-MAX_SCROLLBACK)
  }
  const offData = pty.onData((chunk) => { pending.push(chunk); plen += chunk.length })
  const flushTimer = setInterval(flush, 33)

  // ── INPUT (doc) -> PTY, durable consumed offset on meta ──
  const input = sdoc.getArray<{ d?: string }>('input')
  const meta = sdoc.getMap('meta')
  let consumed = (meta.get('inputConsumed') as number | undefined) ?? 0
  const drain = (): void => {
    const arr = input.toArray()
    for (let i = consumed; i < arr.length; i++) {
      const ev = arr[i]
      if (ev && ev.d != null) pty.write(ev.d)
    }
    if (arr.length !== consumed) {
      consumed = arr.length
      sdoc.transact(() => meta.set('inputConsumed', consumed))
    }
  }
  input.observe(drain)
  drain()

  // ── CONTROL (doc, LWW) -> PTY: resize + kill ──
  const control = sdoc.getMap(CONTROL_KEY)
  const applyControl = (): void => {
    const c = { cols: control.get('cols'), rows: control.get('rows'), kill: control.get('kill') } as ControlState
    if (c.kill) { try { pty.kill() } catch { /* already gone */ } return }
    if (typeof c.cols === 'number' && typeof c.rows === 'number' && (c.cols !== cols || c.rows !== rows)) {
      cols = c.cols; rows = c.rows
      try { pty.resize(cols, rows) } catch { /* pipe backend: no-op */ }
      sdoc.transact(() => { meta.set('cols', cols); meta.set('rows', rows) })
    }
  }
  control.observe(applyControl)
  applyControl()

  // ── SCROLLBACK snapshot -> doc (low-rate append-only for late joiners) ──
  const scrollText = sdoc.getText('scrollback')
  let snapOff = 0
  const snapshot = (): void => {
    if (scroll.length > snapOff) {
      const add = scroll.slice(snapOff)
      sdoc.transact(() => scrollText.insert(scrollText.length, add))
      snapOff = scroll.length
    }
  }
  const snapTimer = setInterval(snapshot, 1500)

  const cleanup = (): void => {
    clearInterval(flushTimer); clearInterval(snapTimer); clearInterval(beatTimer)
    offData(); offExit(); input.unobserve(drain); control.unobserve(applyControl)
    aw?.setLocalStateField(TTY_FIELD, null)       // signal viewers the stream ended
    aw?.setLocalStateField(TERMHOST_FIELD, null)  // drop liveness so viewers see host gone
    try { pty.kill() } catch { /* already gone */ }
  }
  const offExit = pty.onExit(({ exitCode }) => {
    flush(); snapshot()
    setMeta(sdoc, { status: 'exited', exitCode: exitCode ?? 0 })
    sessions.set(id, { ...(sessions.get(id) as SessionSpec), status: 'exited', exitCode: exitCode ?? 0 })
    cleanup()
    active.delete(id)
  })

  const h = active.get(id)
  if (h) h.cleanup = cleanup
}
