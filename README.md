# abracadabra-plugin-terminal

A shared, collaborative **terminal** page type for CouShell. A live shell runs on a
real host machine and is synced to everyone with access to the document.

- **Client** (`src/index.ts` → `dist/plugin.js`): registers the `terminal` page type;
  the renderer (`src/renderer/TerminalRenderer.vue`, **xterm.js**) shows the session.
- **Server** (`src/index.server.ts` → `dist/plugin.server.js`): a `requires:['process']`
  runner that spawns a PTY and bridges it. Runs only on a process-capable host
  (Electron-main utilityProcess / headless Node), skipped by hosts that can't exec.

Typed against the shared **`@abraca/plugin`** contract only — no `@abraca/nuxt`, no
cou-sh imports. The same bundle loads in CouShell and any host that narrows `AbraPlugin`.

## Transport
- live output bytes → **awareness** `tty` (seq sliding-window frames; 300× the doc budget)
- host liveness → **awareness** `termhost` (heartbeat; viewers detect an orphaned session)
- keystrokes → **doc** `input` Y.Array (durable consumed offset)
- resize / kill → **doc** `control` Y.Map (last-write-wins; host applies `pty.resize` / `pty.kill`)
- scrollback / late-join → **doc** `scrollback` Y.Text
- lifecycle → `terminal:sessions` Y.Map on the page doc + session-subdoc `meta`
- host discovery → **awareness** `terminalHost` on the page doc (process-capable clients advertise)

## Features
- **Real PTY** (node-pty) with interactive shell, or a pipe fallback when no PTY backend.
- **Consent gate** before a non-host broadcasts a session request into the room.
- **Live resize** (xterm FitAddon + ResizeObserver → `control`), shared-shell LWW sizing.
- **Stop** button (write-gated) → `control.kill` terminates the shell for everyone.
- **Host-disconnected** detection via the liveness heartbeat (no more silently-frozen sessions).
- **Watch-only** for read-only viewers (no Start, keystrokes suppressed) and for browser/mobile (no host).

## Build
```bash
pnpm install --ignore-workspace
pnpm build        # dist/plugin.js (single-file, xterm+css inlined) + dist/plugin.server.js
pnpm typecheck    # vue-tsc
```
`abra-plugin pack` refreshes the **source** `manifest.json` integrity (`entry: dist/plugin.js`).
The client `vite build` runs with the default `emptyOutDir`, so it wipes `dist/` first — re-emit
the **serve-time** `dist/plugin.manifest.json` (a copy with `entry: plugin.js`) after build+pack
if you serve `dist/` as the plugin root. The runtime loader (`useSpacePlugins`) imports the JS
directly and doesn't read either manifest; they're for `abra-plugin validate` + registry submission.

> Dev note: `tsconfig.json` points `@abraca/plugin` at local source until the Phase-2
> contract (`requires`/`host`/`process:exec`) is published. Drop that override after publish.

## See it live in CouShell (desktop)
The runner host + IPC are wired into `cou-sh/electron` (`ipc/runner-host.cjs`, `main.cjs`,
`preload.cjs` → `electronAPI.runnerHost`). To try it end-to-end:

1. **Enable the plugin** (client): serve `dist/` over http (any port ≠ 3000) and add it as
   an external plugin in CouShell. cou-sh loads it by `import(`${entry.url}.js`)` — so point
   the entry at `http://<host>:<port>/plugin` (it appends `.js`). The renderer chunk is
   inlined into that one file, so a single fetch is enough.
   - **Registry gate**: a plugin that isn't in the catalog is **not** auto-loaded — cou-sh's
     `useSpacePlugins` surfaces it as **Pending** (Settings → Plugins → Pending) behind the
     untrusted-code dialog. Approve it there to load. (Direct `import()`, not the iframe
     sandbox — required, since a page-type renderer is a live Vue component.)
2. **Restart the Electron app** — `main.cjs`/`preload.cjs` changes only take effect on a
   full restart (window reload keeps the stale main process).
3. Create a page, set its type to **Terminal**, click **Start shared session**. On the
   desktop app this forks the runner host (utilityProcess), which claims the session and
   spawns the shell; output streams to every viewer, and editors can type.

Browser/mobile clients render the session **watch-only** (no process host).

## Wiring points still open (in-app)
- **Server URL**: the renderer derives it best-effort from `childProvider`; if your host
  resolves the server differently, set `ABRA_RUNNER_HOST_URL` (main) or wire it through.
- **Identity**: the host uses a persisted **device** key (its own account). With the dev
  `authenticated=editor` cascade it can write any doc; production grants it as a user device.
- **PTY**: the runner host bundles `node-pty` (optionalDependency) and runs a **real PTY** on
  macOS — its prebuilt `spawn-helper` loses the +x bit in pnpm's store, so a `postinstall`
  (`scripts/fix-pty-helper.mjs`) and a runtime guard in `process-capability.mjs` restore it; absent
  node-pty it degrades to the `pipe` backend. For a signed/sandboxed distribution, ship the helper
  with its exec bit (or a Rust pty-helper behind the same `PtyHandle`).
- **Packaging**: the Electron supervisor forks the sibling `abracadabra-runner-host` in dev;
  production must bundle it into resources (override `ABRA_RUNNER_HOST_ENTRY` / `_RUNNERS`).
