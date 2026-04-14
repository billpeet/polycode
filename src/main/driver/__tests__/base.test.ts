import { describe, expect, it } from 'bun:test'
import { shouldForceKillProcess } from '../base'

describe('shouldForceKillProcess', () => {
  it('still escalates after SIGTERM has been sent but the process has not exited yet', () => {
    expect(shouldForceKillProcess({
      exitCode: null,
      signalCode: null,
    })).toBe(true)
  })

  it('does not escalate once the process has exited', () => {
    expect(shouldForceKillProcess({
      exitCode: 0,
      signalCode: null,
    })).toBe(false)

    expect(shouldForceKillProcess({
      exitCode: null,
      signalCode: 'SIGTERM',
    })).toBe(false)
  })
})
