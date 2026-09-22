import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // The repository-root shared tree, the same modules the server compiles from
        // ../shared/... . It needs its own alias because the frontend lint override forbids
        // the relative imports that would otherwise be the only way to reach it. This alias
        // is the bundle's copy; vitest.config.ts carries its own, because vitest does not
        // read this file, and tsconfig.json and .oxlintrc.json carry theirs.
        '@shared': fileURLToPath(new URL('./shared', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      // Host header allowlist (dev server only; this is Vite's DNS-rebinding guard).
      // A leading dot allows the domain itself AND every subdomain, so any zrok share
      // in this zone works — the share name changes on each `zrok share` restart.
      allowedHosts: ['.shares.zrok.io'],
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      // Vite empties outDir on EVERY build pass, and `vite build --watch` re-runs the
      // whole pipeline per change. That would blank dist/ for the length of each rebuild
      // (rollup only writes at the end), so a refresh mid-rebuild 404s. Keeping old
      // hashed chunks also lets a page loaded before the rebuild finish its requests.
      emptyOutDir: false,
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    }
  }
})
