<script setup lang="ts">
/**
 * Terminal page-type renderer. Loaded by CouShell with the standard plugin
 * renderer props ({ docId, childProvider, docLabel, editable }) — it works
 * entirely off `childProvider` (page Y.Doc + awareness + loadChild), so it
 * pulls in NO cou-sh-internal composables and stays a portable standalone plugin.
 *
 * Output is read from the session subdoc's AWARENESS stream (seq frames, gap-
 * recovered from the doc scrollback); keystrokes are written to the subdoc's
 * `input` Y.Array; resize/kill go to the subdoc's `control` Y.Map. The PTY is
 * hosted by a process-capable runner host elsewhere, which publishes a liveness
 * heartbeat on awareness so we can tell a live host from an orphaned session.
 */
import { ref, shallowRef, onMounted, onBeforeUnmount, computed } from 'vue'
import type * as Y from 'yjs'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  SESSIONS_KEY, TTY_FIELD, TERMHOST_FIELD, HOST_ADVERTISE_FIELD, CONTROL_KEY, HOST_STALE_MS,
  latin1ToBytes,
  type SessionSpec, type TtyAwareness, type TermHostPresence, type HostAdvertise, type InputEvent,
} from '../session.ts'

interface AwarenessLike {
  getStates(): Map<number, Record<string, unknown>>
  getLocalState?(): Record<string, unknown> | null
  setLocalStateField?(field: string, value: unknown): void
  on(e: string, cb: () => void): void
  off(e: string, cb: () => void): void
  clientID: number
}
interface SubProvider { document: Y.Doc; awareness: AwarenessLike | null }
interface PageProvider {
  document: Y.Doc
  awareness?: AwarenessLike | null
  loadChild(id: string, opts?: { evictable?: boolean }): Promise<SubProvider>
  unloadChild?(id: string): void
}
// `editable` mirrors the host's write permission (cou-sh binds `:editable="canWrite"`).
// A read-only viewer must not see a Start button and must not push keystrokes —
// the server would reject those doc-writes anyway, so gating here keeps the UX honest.
const props = withDefaults(
  defineProps<{ docId: string; childProvider: PageProvider; docLabel?: string; editable?: boolean }>(),
  { editable: true },
)

const termEl = ref<HTMLDivElement | null>(null)
const status = ref<'idle' | 'requesting' | 'waiting' | 'running' | 'disconnected' | 'exited' | 'error'>('idle')
const hostName = ref<string | null>(null)
const errorMsg = ref('')
const showConsent = ref(false)
const availableHosts = shallowRef<string[]>([])

// Hosting needs a process-capable runner host (the CouShell desktop app exposes
// one on electronAPI.runnerHost). Browser/mobile have none → watch-only.
interface RunnerHostApi { start(c: unknown): Promise<unknown>; stop(): Promise<unknown>; status(): Promise<unknown> }
const electronAPI = (globalThis as unknown as { electronAPI?: { runnerHost?: RunnerHostApi } }).electronAPI
const canHostHere = !!electronAPI?.runnerHost

function localUserName(): string {
  const ls = props.childProvider.awareness?.getLocalState?.() as Record<string, any> | null | undefined
  return ls?.user?.name || ls?.name || ls?.displayName || 'a desktop app'
}
function deriveServerUrl(): string | undefined {
  const cp = props.childProvider as unknown as { client?: { baseUrl?: string }; configuration?: { url?: string } }
  const g = globalThis as unknown as { __ABRACADABRA_SERVER__?: string }
  return cp.client?.baseUrl || cp.configuration?.url || g.__ABRACADABRA_SERVER__ || undefined
}

let term: Terminal | null = null
let fit: FitAddon | null = null
let sub: SubProvider | null = null
let sessionId: string | null = null
let control: Y.Map<unknown> | null = null
let awChange: (() => void) | null = null
let metaObs: (() => void) | null = null
let waitTimer: ReturnType<typeof setTimeout> | null = null
let staleTimer: ReturnType<typeof setInterval> | null = null
let resizeDebounce: ReturnType<typeof setTimeout> | null = null
let ro: ResizeObserver | null = null
let pageAwChange: (() => void) | null = null
let lastHostSeen = 0
let themeObs: MutationObserver | null = null
let colorProbe: HTMLSpanElement | null = null

const MONO_FALLBACK = 'var(--font-code, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace)'

// Resolve the active code-font stack chosen in Settings → Appearance (`--font-code`)
// to a concrete family string for xterm's char measurement. The `:deep(.xterm…)`
// CSS rule then keeps the rendered rows on `var(--font-code)` live (and beats the
// global `html[data-font] *` body-font !important rule that would otherwise force
// the app font onto the terminal).
function readCodeFont(): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-code').trim()
    return v || 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
  } catch { return 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' }
}

// xterm's colour parser only understands #hex / rgb() — not oklch (Nuxt UI v4
// tokens). Resolve any CSS colour expression to a computed rgb() via a probe
// element so the terminal surface tracks the app's `--ui-*` palette and theme.
function resolveColor(expr: string, fallback: string): string {
  try {
    if (!colorProbe) {
      colorProbe = document.createElement('span')
      colorProbe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none'
      document.body.appendChild(colorProbe)
    }
    colorProbe.style.color = ''
    colorProbe.style.color = expr
    return getComputedStyle(colorProbe).color || fallback
  } catch { return fallback }
}

// Map the app's semantic tokens onto an xterm theme so light/dark + identity
// colours flow through to the shell surface.
function buildTheme(): Record<string, string> {
  const bg = resolveColor('var(--ui-bg)', '#0b0b0e')
  const fg = resolveColor('var(--ui-text-highlighted)', '#e6e6ea')
  const dim = resolveColor('var(--ui-text-dimmed)', '#6b6b76')
  const accent = resolveColor('var(--ui-primary)', '#7fdca0')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: resolveColor('var(--ui-bg-accented)', 'rgba(255,255,255,0.18)'),
    selectionForeground: fg,
    black: resolveColor('var(--ui-color-neutral-900)', '#18181b'),
    red: resolveColor('var(--ui-color-error-500)', '#ef4444'),
    green: resolveColor('var(--ui-color-success-500)', '#10b981'),
    yellow: resolveColor('var(--ui-color-warning-500)', '#f59e0b'),
    blue: resolveColor('var(--ui-color-info-500)', '#3b82f6'),
    magenta: resolveColor('var(--ui-color-primary-500)', '#8b5cf6'),
    cyan: '#06b6d4',
    white: fg,
    brightBlack: dim,
  }
}

const sessions = (): Y.Map<SessionSpec> => props.childProvider.document.getMap<SessionSpec>(SESSIONS_KEY)

function pickExistingSession(): string | null {
  for (const [id, s] of sessions().entries()) {
    if (s && (s.status === 'running' || s.status === 'starting' || s.status === 'requested')) return id
  }
  return null
}

async function attach(id: string): Promise<void> {
  sessionId = id
  sub = await props.childProvider.loadChild(id, { evictable: false })
  const sdoc = sub.document
  const aw = sub.awareness
  control = sdoc.getMap(CONTROL_KEY)

  // OUTPUT: reconstruct the byte stream from awareness frames, in seq order,
  // with gap recovery from the doc scrollback (matches the runner's window).
  // Also track host LIVENESS from the heartbeat field (and from any frame).
  let nextSeq = 1
  const buffer = new Map<number, string>()
  let maxSeen = 0
  const reconcile = (): void => {
    const text = sdoc.getText('scrollback').toString()
    term?.reset()
    if (text) term?.write(latin1ToBytes(text))
    nextSeq = maxSeen + 1
    buffer.clear()
  }
  const markLive = (): void => {
    lastHostSeen = Date.now()
    if (status.value === 'disconnected') status.value = 'running'
  }
  awChange = () => {
    if (!aw) return
    for (const st of aw.getStates().values()) {
      const presence = st[TERMHOST_FIELD] as TermHostPresence | undefined
      if (presence) { hostName.value = presence.name; markLive() }
      const tty = st[TTY_FIELD] as TtyAwareness | undefined
      if (!tty?.frames) continue
      hostName.value ||= tty.host
      markLive()
      for (const f of tty.frames) {
        if (f.seq > maxSeen) maxSeen = f.seq
        if (f.seq >= nextSeq) buffer.set(f.seq, f.d)
      }
    }
    if (buffer.size) {
      const minSeq = Math.min(...buffer.keys())
      if (minSeq > nextSeq) { reconcile(); return }   // fell out of the window → catch up from scrollback
      while (buffer.has(nextSeq)) { term?.write(latin1ToBytes(buffer.get(nextSeq)!)); buffer.delete(nextSeq); nextSeq++ }
    }
  }
  aw?.on('change', awChange)
  awChange()

  // INPUT: keystrokes -> doc `input` array (the host drains them to the PTY).
  const input = sdoc.getArray<InputEvent>('input')
  let kseq = 0
  term?.onData((d) => { if (props.editable === false) return; input.push([{ seq: ++kseq, t: Date.now(), d }]) })

  // RESIZE: local terminal size -> control map (host applies pty.resize). LWW —
  // in a shared shell the last attacher's size wins (tmux-style).
  term?.onResize(({ cols, rows }) => sendResize(cols, rows))

  // STATUS: follow session lifecycle from the subdoc meta + sessions map.
  const meta = sdoc.getMap('meta')
  const reflect = (): void => {
    const m = (sessions().get(id)?.status) ?? (meta.get('status') as SessionSpec['status'] | undefined)
    if (m === 'running') {
      if (status.value !== 'disconnected') status.value = 'running'
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = null }
    } else if (m === 'exited') status.value = 'exited'
    else if (m === 'error') { status.value = 'error'; errorMsg.value = (sessions().get(id)?.error) ?? 'session error' }
  }
  metaObs = () => reflect()
  meta.observe(metaObs)
  sessions().observe(metaObs)
  reflect()

  // LIVENESS watchdog: a running session whose host beat went stale (host crashed
  // or lost its connection) flips to `disconnected` so a viewer isn't misled.
  if (!staleTimer) {
    staleTimer = setInterval(() => {
      if (status.value === 'running' && lastHostSeen && Date.now() - lastHostSeen > HOST_STALE_MS) {
        status.value = 'disconnected'
      }
    }, 2000)
  }
}

function sendResize(cols: number, rows: number): void {
  if (props.editable === false || !control) return
  if (resizeDebounce) clearTimeout(resizeDebounce)
  resizeDebounce = setTimeout(() => {
    sub?.document.transact(() => { control!.set('cols', cols); control!.set('rows', rows) })
  }, 150)
}

function requestStart(): void {
  if (canHostHere) { void doStart(); return }  // own machine hosts — no extra warning needed beyond the banner
  showConsent.value = true                      // ask a non-host before it broadcasts a request into the room
}

async function doStart(): Promise<void> {
  showConsent.value = false
  const id = crypto.randomUUID()
  status.value = 'requesting'
  await attach(id) // registers + loads the subdoc so the host can open it
  sessions().set(id, {
    id, status: 'requested', host: null,
    command: undefined,                          // let the host run its own login shell ($SHELL -l)
    cols: term?.cols ?? 80, rows: term?.rows ?? 24,
    startedBy: String(sub?.awareness?.clientID ?? ''),
  })
  // If this client can host (desktop app), spin up the runner host; its terminal
  // runner then claims the `requested` session off the page doc.
  if (electronAPI?.runnerHost) void electronAPI.runnerHost.start({ url: deriveServerUrl(), rootDocId: props.docId })
  status.value = 'waiting'
  lastHostSeen = 0
  waitTimer = setTimeout(() => {
    if (status.value === 'waiting') {
      status.value = 'error'
      errorMsg.value = canHostHere
        ? 'The local host did not claim the session — check the desktop app logs.'
        : 'No host claimed this session. Open the desktop app on a machine with access to host a shell.'
    }
  }, 8000)
}

function stopSession(): void {
  if (props.editable === false || !control) return
  sub?.document.transact(() => control!.set('kill', true))
}

onMounted(async () => {
  term = new Terminal({
    fontSize: 13,
    fontFamily: readCodeFont(),
    convertEol: false,
    cursorBlink: true,
    theme: buildTheme(),
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  if (termEl.value) {
    term.open(termEl.value)
    try { fit.fit() } catch { /* layout not ready */ }
    // Refit on container resize → term.onResize fires → host resizes the PTY.
    ro = new ResizeObserver(() => { try { fit?.fit() } catch { /* mid-layout */ } })
    ro.observe(termEl.value)
  }

  // Re-theme + re-font live when the user toggles dark/light or picks a new
  // body/code font in Settings (the `<html>` class / data-* attributes flip).
  themeObs = new MutationObserver(() => {
    if (!term) return
    term.options.theme = buildTheme()
    const ff = readCodeFont()
    if (term.options.fontFamily !== ff) { term.options.fontFamily = ff; try { fit?.fit() } catch { /* mid-layout */ } }
  })
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-code-font', 'data-font'] })

  // DISCOVERY: a process-capable client advertises that it can host, so viewers
  // without a host of their own know a shell can be started in this room.
  const pageAw = props.childProvider.awareness
  if (canHostHere && pageAw?.setLocalStateField) {
    pageAw.setLocalStateField(HOST_ADVERTISE_FIELD, { name: localUserName(), canHost: true } satisfies HostAdvertise)
  }
  if (pageAw) {
    pageAwChange = () => {
      const names: string[] = []
      for (const [cid, st] of pageAw.getStates()) {
        const adv = st[HOST_ADVERTISE_FIELD] as HostAdvertise | undefined
        if (adv?.canHost && cid !== pageAw.clientID) names.push(adv.name)
      }
      availableHosts.value = names
    }
    pageAw.on('change', pageAwChange)
    pageAwChange()
  }

  const existing = pickExistingSession()
  if (existing) { status.value = 'running'; await attach(existing) }
})

onBeforeUnmount(() => {
  if (waitTimer) clearTimeout(waitTimer)
  if (staleTimer) clearInterval(staleTimer)
  if (resizeDebounce) clearTimeout(resizeDebounce)
  ro?.disconnect()
  themeObs?.disconnect()
  colorProbe?.remove()
  const pageAw = props.childProvider.awareness
  if (pageAw && pageAwChange) pageAw.off('change', pageAwChange)
  if (canHostHere && pageAw?.setLocalStateField) pageAw.setLocalStateField(HOST_ADVERTISE_FIELD, null)
  if (sub?.awareness && awChange) sub.awareness.off('change', awChange)
  if (metaObs) {
    sessions().unobserve(metaObs)
    try { sub?.document.getMap('meta').unobserve(metaObs) } catch { /* subdoc already released */ }
  }
  if (sessionId) props.childProvider.unloadChild?.(sessionId)
  term?.dispose()
})

const running = computed(() => status.value === 'running' || status.value === 'disconnected')
const canStart = computed(() => props.editable && (status.value === 'idle' || status.value === 'exited' || status.value === 'error'))
</script>

<template>
  <div class="abra-terminal">
    <div class="abra-terminal__bar">
      <span class="abra-terminal__title">{{ docLabel || 'Terminal' }}</span>

      <span v-if="status === 'running'" class="abra-terminal__badge is-ok">
        <span class="dot" />shared · host {{ hostName || '…' }} · everyone with access can see &amp; type
      </span>
      <span v-else-if="status === 'disconnected'" class="abra-terminal__badge is-warn">
        <span class="dot" />host disconnected — output paused; the shell may still be running
      </span>
      <span v-else-if="status === 'waiting'" class="abra-terminal__badge is-muted">
        <span class="dot dot--pulse" />waiting for a host…
      </span>
      <span v-else-if="status === 'exited'" class="abra-terminal__badge is-muted">session ended</span>
      <span v-else-if="status === 'error'" class="abra-terminal__badge is-err">
        <span class="dot" />{{ errorMsg }}
      </span>
      <span v-else-if="!editable" class="abra-terminal__badge is-muted">watch-only · no write access</span>
      <span v-else-if="availableHosts.length" class="abra-terminal__badge is-info">
        <span class="dot" />{{ availableHosts.length }} host{{ availableHosts.length > 1 ? 's' : '' }} available · {{ availableHosts.join(', ') }}
      </span>

      <button v-if="canStart" class="abra-terminal__btn abra-terminal__btn--primary abra-terminal__bar-end" @click="requestStart">
        Start shared session
      </button>
      <button v-if="running && editable" class="abra-terminal__btn abra-terminal__btn--danger abra-terminal__bar-end" @click="stopSession">
        Stop
      </button>
    </div>

    <div ref="termEl" class="abra-terminal__view" />

    <p v-if="!canHostHere && (status === 'idle' || status === 'waiting')" class="abra-terminal__hint">
      This view watches the session. A shell runs on a host machine (the desktop app).
    </p>

    <!-- Consent: make it unmistakable that starting shares a live shell with the room. -->
    <div v-if="showConsent" class="abra-terminal__consent">
      <div class="abra-terminal__consent-card">
        <h3>Start a shared shell?</h3>
        <p>
          This starts a <strong>live terminal</strong> that <strong>everyone with access to this
          document can watch and type into</strong>. A shell runs on a host machine in this room —
          its files, processes and network are reachable through it. Only start a session with people
          you trust.
        </p>
        <div class="abra-terminal__consent-actions">
          <button class="abra-terminal__btn" @click="showConsent = false">Cancel</button>
          <button class="abra-terminal__btn abra-terminal__btn--primary" @click="doStart">Start shared session</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.abra-terminal {
  position: relative; display: flex; flex-direction: column;
  height: 100%; min-height: 320px;
  background: var(--ui-bg); color: var(--ui-text);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius, 6px); overflow: hidden;
}
.abra-terminal__bar {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 12px; font-size: 12px;
  color: var(--ui-text-muted);
  background: var(--ui-bg-elevated);
  border-bottom: 1px solid var(--ui-border);
}
.abra-terminal__title { font-weight: 600; color: var(--ui-text-highlighted); flex: none; }

.abra-terminal__badge {
  display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; font-size: 11.5px; color: var(--ui-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.abra-terminal__badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.abra-terminal__badge .dot--pulse { animation: abra-term-pulse 1.4s ease-in-out infinite; }
.abra-terminal__badge.is-ok { color: var(--ui-color-success-500); }
.abra-terminal__badge.is-warn { color: var(--ui-color-warning-500); }
.abra-terminal__badge.is-err { color: var(--ui-color-error-500); }
.abra-terminal__badge.is-info { color: var(--ui-color-primary-500); }
.abra-terminal__badge.is-muted { color: var(--ui-text-dimmed); }
@keyframes abra-term-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

.abra-terminal__btn {
  flex: none; padding: 5px 11px; font-size: 12px; font-weight: 500;
  color: var(--ui-text-highlighted); background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border); border-radius: var(--ui-radius, 6px);
  cursor: pointer; transition: background .12s ease, border-color .12s ease;
}
.abra-terminal__btn:hover { background: var(--ui-bg-accented); }
.abra-terminal__btn--primary {
  color: var(--ui-bg); background: var(--ui-primary);
  border-color: var(--ui-primary); font-weight: 600;
}
.abra-terminal__btn--primary:hover { filter: brightness(1.08); }
.abra-terminal__btn--danger {
  color: var(--ui-color-error-500); background: transparent;
  border-color: color-mix(in oklab, var(--ui-color-error-500) 45%, transparent);
}
.abra-terminal__btn--danger:hover { background: color-mix(in oklab, var(--ui-color-error-500) 14%, transparent); }
.abra-terminal__bar-end { margin-left: auto; }

.abra-terminal__view { flex: 1; min-height: 0; padding: 6px 8px; background: var(--ui-bg); }
.abra-terminal__hint {
  margin: 0; padding: 6px 12px; font-size: 11px;
  color: var(--ui-text-dimmed); background: var(--ui-bg-elevated);
  border-top: 1px solid var(--ui-border);
}

/* Keep the terminal grid on the chosen code font and beat the global
   `html[data-font] *` body-font !important rule (mirrors CodeEditor's CodeMirror fix). */
.abra-terminal :deep(.xterm),
.abra-terminal :deep(.xterm .xterm-rows),
.abra-terminal :deep(.xterm .xterm-rows span) {
  font-family: var(--font-code, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace) !important;
}
.abra-terminal :deep(.xterm .xterm-viewport) { background: transparent !important; }

.abra-terminal__consent {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: color-mix(in oklab, var(--ui-bg) 55%, transparent);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: 10;
}
.abra-terminal__consent-card {
  max-width: 420px; margin: 16px; padding: 18px 20px;
  background: var(--ui-bg-elevated); border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius, 6px) * 2); color: var(--ui-text);
  box-shadow: 0 12px 40px rgba(0, 0, 0, .35);
}
.abra-terminal__consent-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
.abra-terminal__consent-card p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.55; color: var(--ui-text-muted); }
.abra-terminal__consent-card strong { color: var(--ui-text-highlighted); }
.abra-terminal__consent-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
