import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import type { Plugin } from 'vite'

// Rewrites external ESM imports to globalThis.__ABRACA_SHARED__.* so the host's
// singletons (one vue, one yjs) are reused. Replaces @abraca/vite-plugin until
// that's published. The terminal plugin uses no TipTap.
function abraShim(): Plugin {
  const EXTERNALS: Record<string, string> = { vue: 'vue', yjs: 'yjs' }
  return {
    name: 'abra-shim',
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
  // Fold all CSS (xterm + component) into plugin.js — the host loader only fetches the JS.
  plugins: [vue(), cssInjectedByJsPlugin(), abraShim()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'plugin' },
    // Single self-contained plugin.js — external plugins load by URL/blob, where a
    // separate async chunk wouldn't resolve (offline-first code-split trap).
    rollupOptions: { external: ['vue', 'yjs'], output: { inlineDynamicImports: true } },
  },
})
