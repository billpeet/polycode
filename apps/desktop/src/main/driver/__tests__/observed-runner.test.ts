import { describe, expect, it } from 'vitest'
import { FakeRunner } from '../runner/fake'
import { ObservedRunner } from '../runner/observed'

describe('ObservedRunner', () => {
  it('preserves collected command results when telemetry is disabled', async () => {
    const inner = new FakeRunner('wsl')
    inner.queueResult({ stdout: 'main\n', exitCode: 0 })
    const runner = new ObservedRunner(inner)

    const result = await runner.run({ binary: 'git', args: ['branch'], workDir: '/repo' })

    expect(runner.type).toBe('wsl')
    expect(result).toMatchObject({ stdout: 'main\n', exitCode: 0 })
    expect(inner.runCommands).toHaveLength(1)
  })

  it('preserves script execution and non-zero results', async () => {
    const inner = new FakeRunner('ssh')
    inner.queueResult({ stderr: 'failed', exitCode: 2 })
    const runner = new ObservedRunner(inner)

    const result = await runner.runScript({ script: 'private user command' })

    expect(result).toMatchObject({ stderr: 'failed', exitCode: 2 })
    expect(inner.runScriptCommands).toEqual([{ script: 'private user command' }])
  })
})
