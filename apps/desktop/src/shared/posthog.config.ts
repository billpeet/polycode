// Injected at build time from the POSTHOG_API_KEY environment variable.
// The placeholder keeps the integration disabled until a real key is set.
declare const __POSTHOG_API_KEY__: string

export const POSTHOG_API_KEY = __POSTHOG_API_KEY__

export const POSTHOG_API_HOST = 'https://us.i.posthog.com'
