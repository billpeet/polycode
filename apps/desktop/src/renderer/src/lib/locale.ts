import { client } from './client'

/**
 * OS regional-format locale under Electron (supplied by preload). A browser has no
 * such channel, so the navigator's language stands in.
 */
export function systemLocale(): string | undefined {
  return client.systemLocale ?? globalThis.navigator?.language
}

export function formatDateTime(at: Date | string | number): string {
  return new Date(at).toLocaleString(systemLocale())
}

export function formatTime(
  at: Date | string | number,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Date(at).toLocaleTimeString(systemLocale(), options)
}
