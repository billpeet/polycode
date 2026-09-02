import { describe, expect, it } from 'vitest'
import { isReconnectRecovery } from '../remoteConnection'
import type { RemoteConnectionState } from '../../types/ipc'

function state(overrides: Partial<RemoteConnectionState>): RemoteConnectionState {
  return {
    hostId: 'host-1',
    phase: 'connected',
    reconnectAttempt: 0,
    error: null,
    latencyMs: null,
    changedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('isReconnectRecovery', () => {
  it('detects reconnecting → connected on the same host', () => {
    expect(isReconnectRecovery(state({ phase: 'reconnecting' }), state({}))).toBe(true)
  })

  it('detects unavailable → connected on the same host', () => {
    expect(isReconnectRecovery(state({ phase: 'unavailable' }), state({}))).toBe(true)
  })

  it('ignores the initial connect after activating a host', () => {
    // active-changed already resets and refetches everything; bumping the nonce here would
    // double-fetch every mount.
    expect(isReconnectRecovery(state({ phase: 'connecting' }), state({}))).toBe(false)
    expect(isReconnectRecovery(state({ phase: 'local', hostId: null }), state({}))).toBe(false)
  })

  it('ignores a connect against a different host than the one that dropped', () => {
    expect(isReconnectRecovery(
      state({ phase: 'reconnecting', hostId: 'host-1' }),
      state({ hostId: 'host-2' }),
    )).toBe(false)
  })

  it('ignores latency-only re-emissions while connected', () => {
    expect(isReconnectRecovery(state({}), state({ latencyMs: 42 }))).toBe(false)
  })
})
