/**
 * Shared terminal-session schema + helpers (renderer AND runner import this).
 *
 * Hybrid transport (validated in the Phase-1 spike):
 *   - live output bytes -> AWARENESS field `tty` on the session subdoc: ~30Hz
 *     coalesced frames, each carrying a sliding window of the last FRAME_WINDOW
 *     seq-tagged frames (awareness is last-write-wins, so the window makes a
 *     missed update recoverable from the next). Awareness budget is 300x the
 *     doc-update budget, so this is the right channel for a byte stream.
 *   - host liveness -> AWARENESS field `termhost` on the session subdoc: a small
 *     heartbeat the host refreshes every HEARTBEAT_MS so viewers can tell a live
 *     host from an orphaned `running` session (awareness's own disconnect-evict
 *     can lag ~30s, and cross-machine clocks aren't comparable — so viewers key
 *     off their OWN clock at the moment a fresh beat arrives).
 *   - keystrokes (input) -> DOC `input` Y.Array (low-rate), drained to the PTY
 *     with a durable `meta.inputConsumed` offset.
 *   - control (resize / kill) -> DOC `control` Y.Map (last-write-wins) the host
 *     observes: `{ cols, rows }` resizes the PTY, `kill: true` terminates it.
 *   - scrollback / late-joiner catch-up -> DOC `scrollback` Y.Text (low-rate).
 *   - lifecycle -> `terminal:sessions` Y.Map on the page doc + subdoc `meta`.
 *   - host discovery -> AWARENESS field `terminalHost` on the PAGE doc: any
 *     process-capable client advertises that it can host, so viewers without a
 *     host of their own know a shell can be started in this room.
 */
import type * as Y from 'yjs'

/** Y.Map key on the page doc: sessionId -> SessionSpec. */
export const SESSIONS_KEY = 'terminal:sessions'
/** Awareness field the host publishes live output on (per session subdoc). */
export const TTY_FIELD = 'tty'
/** Awareness field the host publishes its liveness heartbeat on (per session subdoc). */
export const TERMHOST_FIELD = 'termhost'
/** Awareness field a process-capable client advertises host availability on (page doc). */
export const HOST_ADVERTISE_FIELD = 'terminalHost'
/** Y.Map key on the session subdoc for resize/kill control (last-write-wins). */
export const CONTROL_KEY = 'control'
/** How many recent frames each awareness update repeats (loss tolerance). */
export const FRAME_WINDOW = 8
/** Max scrollback bytes retained in the doc snapshot. */
export const MAX_SCROLLBACK = 200_000
/** How often the host refreshes its liveness heartbeat. */
export const HEARTBEAT_MS = 2_000
/** Viewer treats a `running` session whose host beat is older than this as disconnected. */
export const HOST_STALE_MS = 6_000

export type SessionStatus = 'requested' | 'starting' | 'running' | 'exited' | 'error'

export interface SessionSpec {
  id: string
  status: SessionStatus
  /** Host that claimed/owns this session, or null while unclaimed. */
  host: string | null
  /** argv to run; the host applies a default login shell when absent. */
  command?: string[]
  cols?: number
  rows?: number
  startedBy?: string | null
  exitCode?: number
  error?: string
}

/** One coalesced output frame. `d` is raw bytes as a latin1 string (JSON-safe). */
export interface TtyFrame { seq: number; d: string }
/** The awareness payload the host publishes on `TTY_FIELD`. */
export interface TtyAwareness { host: string; seq: number; frames: TtyFrame[] }
/** Host liveness heartbeat published on `TERMHOST_FIELD`. `t` is the host's clock (display/ordering only). */
export interface TermHostPresence { hostId: string; name: string; t: number }
/** Host-availability advertisement published on the page doc's `HOST_ADVERTISE_FIELD`. */
export interface HostAdvertise { name: string; canHost: true }
/** One keystroke event appended to the session `input` Y.Array. */
export interface InputEvent { seq: number; t: number; d: string }
/** Control message read from the session `control` Y.Map (last-write-wins). */
export interface ControlState { cols?: number; rows?: number; kill?: boolean }

export function setMeta(doc: Y.Doc, obj: Record<string, unknown>): void {
  const m = doc.getMap('meta')
  doc.transact(() => { for (const k of Object.keys(obj)) m.set(k, obj[k]) })
}

/** Raw bytes (Uint8Array) -> latin1 string for JSON/awareness transport. */
export const bytesToLatin1 = (u8: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!)
  return s
}
/** latin1 string -> raw bytes (for xterm.write). */
export const latin1ToBytes = (s: string): Uint8Array => {
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff
  return u8
}
