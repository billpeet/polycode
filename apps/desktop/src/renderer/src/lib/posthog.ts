import posthog from 'posthog-js/dist/module.full.no-external'

import { POSTHOG_API_HOST, POSTHOG_API_KEY } from '../../../shared/posthog.config'

let enabled = false

export function initPostHog(): void {
  if (enabled || !POSTHOG_API_KEY || POSTHOG_API_KEY.includes('REPLACE')) return
  enabled = true

  posthog.init(POSTHOG_API_KEY, {
    api_host: POSTHOG_API_HOST,
    defaults: '2026-05-30',
    loaded: (instance) => {
      instance.register({ app_version: __APP_VERSION__ })
    },
  })
}

export function trackPostHogEvent(name: string, properties?: Record<string, unknown>): void {
  if (!enabled) return
  posthog.capture(name, properties)
}

export { posthog }
