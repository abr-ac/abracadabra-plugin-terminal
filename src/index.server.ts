/**
 * Terminal plugin — SERVER entry (built to `plugin.server.js`). Contributes the
 * process-capable `terminal` runner. A host that can satisfy `requires:['process']`
 * (Electron-main utilityProcess, headless Node) runs it; a Nitro host skips it.
 */
import type { AbraPlugin } from '@abraca/plugin'
import { createTerminalRunner } from './runner.ts'

const terminalServerPlugin: AbraPlugin = {
  name: 'terminal',
  serverRunners: [createTerminalRunner()],
}

export default terminalServerPlugin
