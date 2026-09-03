import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDateTime, formatTime } from '../locale'

describe('regional date formatting', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { api: { systemLocale: 'en-AU' } })
  })

  it('uses the OS regional locale for dates shown by the renderer', () => {
    const at = new Date(2026, 8, 4, 7, 52, 36)
    expect(formatDateTime(at)).toMatch(/^04\/09\/2026/)
  })

  it('uses the OS regional locale for time-only displays', () => {
    const at = new Date(2026, 8, 4, 17, 52, 36)
    expect(formatTime(at, { hour: 'numeric', minute: '2-digit' })).toMatch(/5:52 pm/i)
  })
})
