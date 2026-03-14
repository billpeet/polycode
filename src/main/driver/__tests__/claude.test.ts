import { describe, it, expect } from 'bun:test'
import { ClaudeDriver } from '../claude'
import type { DriverOptions } from '../types'

function makeDriver(opts: Partial<DriverOptions> = {}): ClaudeDriver {
  return new ClaudeDriver({
    workingDir: '/tmp/test',
    threadId: 'test-thread',
    ...opts,
  })
}

describe('ClaudeDriver buildCommand', () => {
  it('default mode does not force bypass permissions', () => {
    const driver = makeDriver()
    const cmd = (driver as any).buildCommand('hello', 'local', {})
    expect(cmd.args).not.toContain('--dangerously-skip-permissions')
    expect(cmd.args).not.toContain('--permission-mode')
  })

  it('yolo mode adds dangerous skip permissions', () => {
    const driver = makeDriver()
    const cmd = (driver as any).buildCommand('hello', 'local', { yoloMode: true })
    expect(cmd.args).toContain('--dangerously-skip-permissions')
  })

  it('plan mode keeps plan permissions even if yolo is enabled', () => {
    const driver = makeDriver()
    const cmd = (driver as any).buildCommand('hello', 'local', { planMode: true, yoloMode: true })
    expect(cmd.args).toContain('--permission-mode')
    expect(cmd.args).toContain('plan')
    expect(cmd.args).not.toContain('--dangerously-skip-permissions')
  })
})
