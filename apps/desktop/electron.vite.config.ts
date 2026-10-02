import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { readFileSync } from 'node:fs'

// Read the version from package.json itself, not npm_package_version: that is only set
// when the build runs as a package-manager script, and its silent '0.0.0' fallback
// would mislabel every renderer Sentry event and PostHog session. The release workflow
// writes the CI version into this file before building, and electron-builder packages
// the same file — which is what the main process reads through app.getVersion().
const appVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown }
).version
if (typeof appVersion !== 'string' || appVersion.trim() === '') {
  throw new Error('apps/desktop/package.json has no version; the renderer needs one for its Sentry release.')
}

const sentryPlugin = process.env.SENTRY_AUTH_TOKEN
  ? sentryVitePlugin({
      org: 'metroid',
      project: 'polycode',
      authToken: process.env.SENTRY_AUTH_TOKEN,
    })
  : null

export default defineConfig({
  main: {
    // Bundle Sentry's main-process SDK. electron-builder's pnpm dependency
    // collector can omit its transitive browser-utils package from app.asar.
    plugins: [
      externalizeDepsPlugin({ exclude: ['@sentry/electron'] }),
      ...(sentryPlugin ? [sentryPlugin] : []),
    ],
    define: {
      __OTLP_ENDPOINT__: JSON.stringify(process.env.POLYCODE_OTLP_ENDPOINT ?? ''),
      __OTLP_HEADERS__: JSON.stringify(process.env.POLYCODE_OTLP_HEADERS ?? ''),
    },
    build: { sourcemap: true },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss(), ...(sentryPlugin ? [sentryPlugin] : [])],
    // The profiling build keeps `<Profiler onRender>` alive in production. The default
    // build strips it, which is why `react-commit:*` perf reports were absent from a
    // whole week of telemetry while renderer long tasks were not.
    resolve: {
      alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }],
    },
    // Web-client dev loop: open http://localhost:5173 in a browser while `electron-vite
    // dev` runs. There is no preload there, so the renderer takes the web path and its
    // API calls proxy to the running app's remote-control server. `changeOrigin` rewrites
    // Host to the bind address, which is what the server's Host gate expects.
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:3285', changeOrigin: true },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      // PostHog project keys are write-only and safe to embed in the app.
      // CI supplies the real key from the POSTHOG_API_KEY secret; local and
      // dev builds fall back to a placeholder that stays disabled.
      __POSTHOG_API_KEY__: JSON.stringify(
        process.env.POSTHOG_API_KEY ?? 'phc_REPLACE_WITH_YOUR_PROJECT_API_KEY'
      ),
    },
    build: { sourcemap: true },
  },
})
