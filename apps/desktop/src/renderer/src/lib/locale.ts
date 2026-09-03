export function systemLocale(): string | undefined {
  return window.api.systemLocale
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
