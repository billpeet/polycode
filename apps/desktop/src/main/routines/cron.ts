/**
 * Minimal 5-field cron evaluation (minute hour day-of-month month day-of-week),
 * interpreted in machine-local time. Supports `*`, lists, ranges, and steps.
 *
 * The scheduler only ever needs "the most recent scheduled fire time at or
 * before now" — comparing it against a routine's last_fired_at unifies live
 * firing, launch catch-up, and wake catch-up in a single rule, and caps
 * catch-up at one missed instance by construction.
 */

interface CronField {
  values: Set<number>
}

interface CronSpec {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  /** True when the field was `*` — needed for the day-of-month/day-of-week OR rule. */
  domIsWildcard: boolean
  dowIsWildcard: boolean
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      lo = a
      hi = b
    } else {
      const v = Number(rangePart)
      if (!Number.isInteger(v)) return null
      lo = v
      hi = stepPart === undefined ? v : max
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values.size > 0 ? values : null
}

export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = parseField(fields[0], 0, 59)
  const hour = parseField(fields[1], 0, 23)
  const dayOfMonth = parseField(fields[2], 1, 31)
  const month = parseField(fields[3], 1, 12)
  const dayOfWeek = parseField(fields[4], 0, 7)
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  // Cron treats both 0 and 7 as Sunday.
  if (dayOfWeek.has(7)) dayOfWeek.add(0)
  return {
    minute: { values: minute },
    hour: { values: hour },
    dayOfMonth: { values: dayOfMonth },
    month: { values: month },
    dayOfWeek: { values: dayOfWeek },
    domIsWildcard: fields[2] === '*',
    dowIsWildcard: fields[4] === '*',
  }
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null
}

function matches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.has(date.getMinutes())) return false
  if (!spec.hour.values.has(date.getHours())) return false
  if (!spec.month.values.has(date.getMonth() + 1)) return false
  const domMatch = spec.dayOfMonth.values.has(date.getDate())
  const dowMatch = spec.dayOfWeek.values.has(date.getDay())
  // Standard cron: if both day fields are restricted, either matching fires.
  if (!spec.domIsWildcard && !spec.dowIsWildcard) return domMatch || dowMatch
  return domMatch && dowMatch
}

/** How far back to scan for the most recent scheduled firing. */
const SCAN_LIMIT_MINUTES = 60 * 24 * 366

/**
 * The most recent time at or before `now` (truncated to the minute) that the
 * expression fires, or null if none within a year.
 */
export function mostRecentFireTime(expr: string, now: Date): Date | null {
  const spec = parseCron(expr)
  if (!spec) return null
  const cursor = new Date(now)
  cursor.setSeconds(0, 0)
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i++) {
    if (matches(spec, cursor)) return new Date(cursor)
    cursor.setMinutes(cursor.getMinutes() - 1)
  }
  return null
}
