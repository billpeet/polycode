import type { Thread } from './types'

/**
 * Snooze defers a Thread's claim on the user's attention until its wake time.
 *
 * The whole of a snooze is one absolute instant, `Thread.snoozed_until`.
 * Everything else is derived: a thread IS snoozed while that instant is in the
 * future and IS woken once it has passed. Nothing is written when a wake time
 * arrives, so no wake event can be missed while the app is closed.
 *
 * A user-submitted Turn clears `snoozed_until`. That is what makes `isWoken`
 * work with no extra field: the only way a wake time survives its own moment
 * is that the user has not engaged since. Turns started by anything other than
 * the user leave the column alone and so do not discharge the woken state.
 *
 * See ADR-0002 — snooze is a presentation predicate and must never reach a
 * query that gates destructive work.
 */

type SnoozableThread = Pick<Thread, 'snoozed_until'>

/** True while the wake time is still in the future. */
export function isSnoozed(thread: SnoozableThread, now: Date = new Date()): boolean {
  if (!thread.snoozed_until) return false
  return thread.snoozed_until > now.toISOString()
}

/**
 * True once the wake time has passed and the user has not taken a Turn since.
 * Woken threads lead the Queue ahead of every section until discharged.
 */
export function isWoken(thread: SnoozableThread, now: Date = new Date()): boolean {
  if (!thread.snoozed_until) return false
  return thread.snoozed_until <= now.toISOString()
}

/**
 * Formats a wake time as an absolute, unambiguous label.
 *
 * Presets are labelled with the instant they resolve to rather than their
 * relative name, so a roll-forward is visible rather than inferred: picking
 * "This evening" at 9pm must read "Tomorrow, 6:00 PM", not "This evening".
 * Otherwise you snooze for 21 hours believing you snoozed for 3.
 */
export function formatWakeTime(at: Date, now: Date = new Date(), locales?: Intl.LocalesArgument): string {
  const time = at.toLocaleTimeString(locales, { hour: 'numeric', minute: '2-digit' })
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dayOffset = Math.round((new Date(at).setHours(0, 0, 0, 0) - startOfToday.getTime()) / 86_400_000)

  if (dayOffset === 0) return time
  if (dayOffset === 1) return `Tomorrow, ${time}`
  if (dayOffset < 7) return `${at.toLocaleDateString(locales, { weekday: 'long' })}, ${time}`
  return `${at.toLocaleDateString(locales, { month: 'short', day: 'numeric' })}, ${time}`
}

/** How long until a wake time, for rows in a Snoozed section. */
export function timeUntil(iso: string, now: Date = new Date()): string {
  const mins = Math.round((new Date(iso).getTime() - now.getTime()) / 60000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'tomorrow' : `in ${days}d`
}

export type SnoozePresetId = 'one-hour' | 'three-hours' | 'this-evening' | 'tomorrow-morning' | 'next-week'

export interface SnoozePreset {
  id: SnoozePresetId
  label: string
}

/** Hour-of-day anchors for the named presets. Deliberately not configurable. */
const MORNING_HOUR = 9
const EVENING_HOUR = 18

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: 'one-hour', label: 'In an hour' },
  { id: 'three-hours', label: 'In three hours' },
  { id: 'this-evening', label: 'This evening' },
  { id: 'tomorrow-morning', label: 'Tomorrow morning' },
  { id: 'next-week', label: 'Next week' },
]

function atHour(base: Date, dayOffset: number, hour: number): Date {
  const result = new Date(base)
  result.setDate(result.getDate() + dayOffset)
  result.setHours(hour, 0, 0, 0)
  return result
}

/**
 * Resolves a preset to an absolute instant in the *caller's* timezone.
 *
 * Presets always roll forward to their next occurrence, so no preset ever
 * resolves to a moment that has already passed — a snooze that woke
 * immediately would be a no-op dressed as an action. Callers must label the
 * resolved absolute time rather than the relative preset name, so a
 * roll-forward is visible rather than inferred ("This evening" at 9pm means
 * tomorrow, and should say so).
 *
 * Resolution happens client-side by design: "morning" means morning where the
 * user is, not where the host machine is. Only the resolved instant is sent.
 */
export function resolveSnoozePreset(id: SnoozePresetId, now: Date = new Date()): Date {
  switch (id) {
    case 'one-hour':
      return new Date(now.getTime() + 60 * 60 * 1000)
    case 'three-hours':
      return new Date(now.getTime() + 3 * 60 * 60 * 1000)
    case 'this-evening': {
      const tonight = atHour(now, 0, EVENING_HOUR)
      return tonight > now ? tonight : atHour(now, 1, EVENING_HOUR)
    }
    case 'tomorrow-morning':
      return atHour(now, 1, MORNING_HOUR)
    case 'next-week': {
      // Next Monday. On a Monday this means the following one, never today.
      const daysUntilMonday = ((8 - now.getDay()) % 7) || 7
      return atHour(now, daysUntilMonday, MORNING_HOUR)
    }
  }
}
