import { describe, expect, it } from 'vitest'
import {
  formatWakeTime,
  isSnoozed,
  isWoken,
  resolveSnoozePreset,
  SNOOZE_PRESETS,
  timeUntil,
} from '../snooze'

/**
 * Tests for the shared snooze logic, used identically by desktop and mobile.
 * The shared package is consumed as raw TypeScript and has no test runner of
 * its own, so these execute under the desktop's vitest `shared` project.
 *
 * Every `now` here is built from local date components rather than a UTC string,
 * because the presets anchor to local wall-clock hours by design ("morning"
 * means morning where the user is). Parsing a fixed UTC instant would make these
 * assertions pass or fail depending on the machine's timezone.
 */
describe('isSnoozed / isWoken', () => {
  const now = new Date('2026-08-10T12:00:00Z')

  it('treats a future wake time as snoozed and not woken', () => {
    const thread = { snoozed_until: '2026-08-10T18:00:00Z' }
    expect(isSnoozed(thread, now)).toBe(true)
    expect(isWoken(thread, now)).toBe(false)
  })

  it('treats a past wake time as woken and not snoozed', () => {
    const thread = { snoozed_until: '2026-08-10T09:00:00Z' }
    expect(isSnoozed(thread, now)).toBe(false)
    expect(isWoken(thread, now)).toBe(true)
  })

  it('treats a null wake time as neither', () => {
    // A user-submitted Turn nulls the column, which is what discharges the
    // woken state — so null must not read as woken.
    const thread = { snoozed_until: null }
    expect(isSnoozed(thread, now)).toBe(false)
    expect(isWoken(thread, now)).toBe(false)
  })
})

describe('resolveSnoozePreset', () => {
  it('never resolves a preset into the past', () => {
    // A snooze that woke immediately would be a no-op dressed as an action.
    // Checked across a full day of starting points, including the exact anchors.
    for (const hour of [0, 3, 8, 9, 12, 17, 18, 21, 23]) {
      const now = new Date(2026, 7, 10, hour, 30, 0)
      for (const preset of SNOOZE_PRESETS) {
        const at = resolveSnoozePreset(preset.id, now)
        expect(at.getTime(), `${preset.id} at ${hour}:30`).toBeGreaterThan(now.getTime())
      }
    }
  })

  it('resolves "this evening" to today when the anchor is still ahead', () => {
    const now = new Date(2026, 7, 10, 12, 0, 0)
    const at = resolveSnoozePreset('this-evening', now)
    expect(at.getDate()).toBe(10)
    expect(at.getHours()).toBe(18)
  })

  it('rolls "this evening" forward to tomorrow once the anchor has passed', () => {
    const now = new Date(2026, 7, 10, 21, 0, 0)
    const at = resolveSnoozePreset('this-evening', now)
    expect(at.getDate()).toBe(11)
    expect(at.getHours()).toBe(18)
  })

  it('reads "tomorrow morning" at 3am as the coming day, not six hours away', () => {
    // The "3am is still tonight" intuition is real but unresolvable without a
    // day-boundary concept. The label carries the absolute time so the ~30h
    // result is visible rather than surprising.
    const now = new Date(2026, 7, 10, 3, 0, 0)
    const at = resolveSnoozePreset('tomorrow-morning', now)
    expect(at.getDate()).toBe(11)
    expect(at.getHours()).toBe(9)
  })

  it('resolves "next week" to a Monday strictly within the next 7 days', () => {
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const now = new Date(2026, 7, 10 + dayOffset, 14, 0, 0)
      const at = resolveSnoozePreset('next-week', now)
      expect(at.getDay(), 'lands on a Monday').toBe(1)
      expect(at.getHours()).toBe(9)
      const days = (at.getTime() - now.getTime()) / 86_400_000
      expect(days).toBeGreaterThan(0)
      expect(days).toBeLessThanOrEqual(7)
    }
  })

  it('never resolves "next week" to today, even on a Monday', () => {
    const monday = new Date(2026, 7, 10, 14, 0, 0)
    // Walk to a known Monday regardless of what weekday the 10th is.
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7))
    expect(monday.getDay()).toBe(1)

    const at = resolveSnoozePreset('next-week', monday)
    expect(at.getDate()).not.toBe(monday.getDate())
    expect((at.getTime() - monday.getTime()) / 86_400_000).toBeCloseTo(7 - 5 / 24, 1)
  })
})

describe('formatWakeTime', () => {
  it('accepts the client regional locale', () => {
    const now = new Date(2026, 8, 1, 12, 0, 0)
    const at = new Date(2026, 8, 10, 18, 0, 0)
    expect(formatWakeTime(at, now, 'en-AU')).toMatch(/^10 Sept/)
  })

  it('labels today with only a time', () => {
    const now = new Date(2026, 7, 10, 12, 0, 0)
    expect(formatWakeTime(new Date(2026, 7, 10, 18, 0, 0), now)).not.toMatch(/Tomorrow|,/)
  })

  it('labels the next day as Tomorrow so a roll-forward is visible', () => {
    const now = new Date(2026, 7, 10, 21, 0, 0)
    const at = resolveSnoozePreset('this-evening', now)
    expect(formatWakeTime(at, now)).toMatch(/^Tomorrow, /)
  })
})

describe('timeUntil', () => {
  const now = new Date('2026-08-10T12:00:00Z')

  it('describes an elapsed wake time as now', () => {
    expect(timeUntil('2026-08-10T11:00:00Z', now)).toBe('now')
  })

  it('describes minutes, hours, and days', () => {
    expect(timeUntil('2026-08-10T12:30:00Z', now)).toBe('in 30m')
    expect(timeUntil('2026-08-10T15:00:00Z', now)).toBe('in 3h')
    expect(timeUntil('2026-08-13T12:00:00Z', now)).toBe('in 3d')
  })
})
