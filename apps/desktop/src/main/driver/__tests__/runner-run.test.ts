import { describe, expect, it } from 'vitest'
import { LocalRunner } from '../runner/local'
import { FakeRunner } from '../runner/fake'

const workDir = process.cwd()

describe('Runner.run', () => {
  it('collects stdout, stderr, and a non-zero exit as data', async () => {
    const runner = new LocalRunner()
    const result = process.platform === 'win32'
      ? await runner.run({
        binary: 'cmd',
        args: ['/d', '/s', '/c', 'echo out & echo err 1>&2 & exit /b 7'],
        workDir,
      })
      : await runner.run({
        binary: 'sh',
        args: ['-c', 'printf out; printf err >&2; exit 7'],
        workDir,
      })

    expect(result.stdout.trim()).toBe('out')
    expect(result.stderr.trim()).toBe('err')
    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
  })

  it('returns a timed-out result', async () => {
    const runner = new LocalRunner()
    const result = process.platform === 'win32'
      ? await runner.run({
        binary: 'powershell',
        args: ['-NonInteractive', '-Command', 'Start-Sleep -Seconds 2'],
        workDir,
        timeoutMs: 10,
      })
      : await runner.run({
        binary: 'sh',
        args: ['-c', 'sleep 2'],
        workDir,
        timeoutMs: 10,
      })

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
  })
})

describe('FakeRunner', () => {
  it('records semantic run commands and returns queued results', async () => {
    const runner = new FakeRunner('ssh')
    runner.queueResult({ stdout: 'ok\n' })

    const command = { binary: 'git', args: ['status'], workDir }
    await expect(runner.run(command)).resolves.toMatchObject({ stdout: 'ok\n', exitCode: 0 })
    expect(runner.runCommands).toEqual([command])
    expect(runner.type).toBe('ssh')
  })
})
