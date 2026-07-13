import { describe, expect, it } from 'vitest'
import { getCurrentLocationId } from '../currentLocation'

describe('getCurrentLocationId', () => {
  it('uses the selected thread location instead of the first worktree', () => {
    const locations = [
      { id: 'main', pool_id: null, checked_out: false },
      { id: 'worktree', pool_id: 'pool', checked_out: true },
    ]
    const threads = [
      { id: 'thread-main', location_id: 'main' },
      { id: 'thread-worktree', location_id: 'worktree' },
    ]

    expect(getCurrentLocationId(threads as never, 'thread-worktree', locations as never)).toBe('worktree')
  })

  it('falls back to the first active location when no thread is selected', () => {
    const locations = [
      { id: 'available-pool-location', pool_id: 'pool', checked_out: false },
      { id: 'main', pool_id: null, checked_out: false },
    ]

    expect(getCurrentLocationId([], null, locations as never)).toBe('main')
  })
})
