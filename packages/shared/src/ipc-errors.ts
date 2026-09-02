export const APP_SHUTTING_DOWN_CODE = 'APP_SHUTTING_DOWN' as const

const APP_SHUTTING_DOWN_TEXT = 'PolyCode is shutting down'

export function appShuttingDownMessage(): string {
  return `[${APP_SHUTTING_DOWN_CODE}] ${APP_SHUTTING_DOWN_TEXT}`
}

export function isAppShuttingDownError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if ((error as { code?: unknown }).code === APP_SHUTTING_DOWN_CODE) return true
  }

  const message = error instanceof Error ? error.message : String(error)
  return message.includes(`[${APP_SHUTTING_DOWN_CODE}]`)
}
