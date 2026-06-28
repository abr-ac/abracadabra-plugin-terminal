/**
 * Terminal plugin — CLIENT entry. Registers the `terminal` page type whose
 * renderer is an xterm.js terminal fed by the session's awareness stream.
 *
 * Typed against the shared `@abraca/plugin` contract (NOT cou-sh's `CouPlugin`
 * and NOT `@abraca/nuxt`) so the same bundle loads in CouShell today and any
 * other host that narrows `AbraPlugin`.
 */
import { defineAsyncComponent } from 'vue'
import type { AbraPlugin } from '@abraca/plugin'

const terminalPlugin: AbraPlugin = {
  name: 'terminal',
  label: 'Terminal',
  version: '0.1.0',
  description: 'A shared, collaborative shell — hosted on a real machine, synced to everyone with access to the document.',

  pageTypes: {
    terminal: {
      key: 'terminal',
      label: 'Terminal',
      icon: 'i-lucide-terminal',
      description: 'A shared, collaborative shell session',
      available: true,
      supportsChildren: false,
      component: defineAsyncComponent(() => import('./renderer/TerminalRenderer.vue')),
    },
  },

  // Awareness fields this plugin reads/writes:
  //  - session subdoc: `tty` (host's live output) + `termhost` (host liveness heartbeat)
  //  - page doc: `terminalHost` (a process-capable client advertises it can host)
  awarenessContributions: [
    { keys: ['tty', 'termhost'] },
    { keys: ['terminalHost'] },
  ],
}

export default terminalPlugin
