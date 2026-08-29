import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'

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
    build: { sourcemap: true },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss(), ...(sentryPlugin ? [sentryPlugin] : [])],
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
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
