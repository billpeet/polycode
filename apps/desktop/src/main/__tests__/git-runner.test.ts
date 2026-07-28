import { describe, expect, it, vi } from 'vitest'
import { FakeRunner } from '../driver/runner/fake'
import { GitCommandError, GitLockedError, extractLockPathFromStderr, runGit } from '../git-runner'

describe('extractLockPathFromStderr', () => {
  it.each([
    ["fatal: Unable to create 'C:/repo/.git/index.lock': File exists.", 'C:/repo/.git/index.lock'],
    ['Another git process seems to be running in this repository', 'index.lock'],
    ["fatal: cannot lock ref 'refs/heads/main': Unable to create '/repo/.git/refs/heads/main.lock': File exists.", '/repo/.git/refs/heads/main.lock'],
    ['fatal: not a git repository', null],
  ])('extracts a lock path from %s', (stderr, expected) => {
    expect(extractLockPathFromStderr(stderr)).toBe(expected)
  })
})

describe('runGit', () => {
  it('runs a semantic git command and trims only trailing whitespace', async () => {
    const runner = new FakeRunner('wsl')
    runner.queueResult({ stdout: '  value\n' })

    await expect(runGit(runner, '/repo', ['status', '--short'])).resolves.toBe('  value')
    expect(runner.runCommands).toEqual([{
      binary: 'git',
      args: ['status', '--short'],
      workDir: '/repo',
      maxOutputBytes: 4 * 1024 * 1024,
    }])
  })

  it('retries lock contention with quadratic backoff', async () => {
    const runner = new FakeRunner()
    runner.queueResult({ stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.", exitCode: 128 })
    runner.queueResult({ stderr: 'Another git process seems to be running in this repository', exitCode: 128 })
    runner.queueResult({ stdout: 'ok\n' })
    const delay = vi.fn(async () => undefined)

    await expect(runGit(runner, '/repo', ['fetch'], { delay })).resolves.toBe('ok')
    expect(delay.mock.calls).toEqual([[50], [200]])
    expect(runner.runCommands).toHaveLength(3)
  })

  it('throws GitLockedError after the final lock failure', async () => {
    const runner = new FakeRunner()
    runner.queueResult({ stderr: 'Another git process seems to be running in this repository', exitCode: 128 })
    runner.queueResult({ stderr: 'Another git process seems to be running in this repository', exitCode: 128 })

    await expect(runGit(runner, '/repo', ['checkout', 'main'], {
      maxAttempts: 2,
      delay: async () => undefined,
    })).rejects.toMatchObject<Partial<GitLockedError>>({
      name: 'GitLockedError',
      lockPath: 'index.lock',
    })
  })

  it('throws a stderr-bearing error without retrying other failures', async () => {
    const runner = new FakeRunner()
    runner.queueResult({ stdout: 'partial', stderr: 'fatal: bad revision', exitCode: 128 })

    await expect(runGit(runner, '/repo', ['show', 'missing'])).rejects.toMatchObject<Partial<GitCommandError>>({
      name: 'GitCommandError',
      stdout: 'partial',
      stderr: 'fatal: bad revision',
      exitCode: 128,
    })
    expect(runner.runCommands).toHaveLength(1)
  })
})
