// Only code-owned labels and numeric measurements belong in crash context.
const recent: { at: number; name: string; durationMs?: number }[] = []
export function recordCrashBreadcrumb(name: string, durationMs?: number): void {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name)) return
  recent.push({ at: Date.now(), name, ...(Number.isFinite(durationMs) ? { durationMs } : {}) })
  if (recent.length > 40) recent.shift()
}
export function crashBreadcrumbs(): typeof recent {
  return recent.map((entry) => ({ ...entry }))
}
