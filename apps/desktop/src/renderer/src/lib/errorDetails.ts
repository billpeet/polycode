export function formatErrorDetails(context: Record<string, unknown>, error?: unknown): string {
  const payload: Record<string, unknown> = {
    ...context,
    timestamp: new Date().toISOString(),
  }

  if (error !== undefined) {
    payload.error = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack ?? null,
        }
      : String(error)
  }

  return JSON.stringify(payload, null, 2)
}
