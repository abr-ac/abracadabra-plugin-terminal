import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Server build: the runner observes Y.Docs and spawns a PTY via the host's
// injected `process` capability. yjs is host-provided; no vue.
function abraShimServer(): Plugin {
  const EXTERNALS: Record<string, string> = { yjs: 'yjs' }
  return {
    name: 'abra-shim-server',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const [pkg, key] of Object.entries(EXTERNALS)) {
          const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          chunk.code = chunk.code.replace(
            new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escaped}["']`, 'g'),
            // `import { a as b }` → `const { a: b }`: object destructuring
            // renames with `:`, not the import-only `as` keyword.
            (_m: string, names: string) =>
              `const {${names.replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$1: $2')}} = globalThis.__ABRACA_SHARED__["${key}"]`,
          )
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [abraShimServer()],
  build: {
    // Don't wipe the client's plugin.js (both builds target dist/).
    emptyOutDir: false,
    lib: { entry: 'src/index.server.ts', formats: ['es'], fileName: 'plugin.server' },
    rollupOptions: { external: ['yjs'] },
  },
})
