import { describe, expect, it } from 'vitest'
import { isValidCron, mostRecentFireTime } from '../cron'

const at = (iso: string) => new Date(iso)

describe('cron parsing', () => {
  it('accepts common expressions', () => {
    expect(isValidCron('0 8 * * *')).toBe(true)
    expect(isValidCron('30 8 * * 1-5')).toBe(true)
    expect(isValidCron('*/15 * * * *')).toBe(true)
    expect(isValidCron('0 0 1 * *')).toBe(true)
    expect(isValidCron('0 9 * * 0,6')).toBe(true)
  })

  it('rejects malformed expressions', () => {
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('0 8 * *')).toBe(false)
    expect(isValidCron('60 8 * * *')).toBe(false)
    expect(isValidCron('0 24 * * *')).toBe(false)
    expect(isValidCron('a b c d e')).toBe(false)
    expect(isValidCron('5-1 * * * *')).toBe(false)
  })
})

describe('mostRecentFireTime', () => {
  it('returns the fire minute itself when now is exactly on it', () => {
    // Local-time construction: 2026-08-13 is a Thursday.
    const now = new Date(2026, 7, 13, 8, 0, 30)
    expect(mostRecentFireTime('0 8 * * *', now)).toEqual(new Date(2026, 7, 13, 8, 0, 0))
  })

  it('returns the previous day when today’s firing has not happened yet', () => {
    const now = new Date(2026, 7, 13, 7, 59, 0)
    expect(mostRecentFireTime('0 8 * * *', now)).toEqual(new Date(2026, 7, 12, 8, 0, 0))
  })

  it('skips the weekend for weekday schedules', () => {
    // Sunday 2026-08-16 → most recent weekday firing is Friday the 14th.
    const now = new Date(2026, 7, 16, 12, 0, 0)
    expect(mostRecentFireTime('0 8 * * 1-5', now)).toEqual(new Date(2026, 7, 14, 8, 0, 0))
  })

  it('handles step expressions', () => {
    const now = new Date(2026, 7, 13, 8, 44, 0)
    expect(mostRecentFireTime('*/15 * * * *', now)).toEqual(new Date(2026, 7, 13, 8, 30, 0))
  })

  it('treats 7 as Sunday', () => {
    const now = new Date(2026, 7, 17, 12, 0, 0) // Monday
    expect(mostRecentFireTime('0 9 * * 7', now)).toEqual(new Date(2026, 7, 16, 9, 0, 0))
  })

  it('returns null for invalid expressions', () => {
    expect(mostRecentFireTime('not cron', at('2026-08-13T12:00:00'))).toBeNull()
  })
})
