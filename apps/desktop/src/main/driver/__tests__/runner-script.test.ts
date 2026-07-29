/**
 * Characterisation tests for Runner.spawnScript / Runner.runScript.
 *
 * These assert the exact argv each adapter constructs, because that argv is the
 * whole behaviour: it is what the five converted shell-exec families used to
 * build by hand. An integration test that shells out cannot run on CI for wsl or
 * ssh, and would not catch a transport being selected wrongly — the command
 * would still succeed, just in the wrong place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

const spawnMock = vi.fn()

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) }
})

const { LocalRunner } = await import('../runner/local')
const { WslRunner } = await import('../runner/wsl')
const { SshRunner } = await import('../runner/ssh')
const { FakeRunner } = await import('../runner/fake')
const { LOAD_NODE_MANAGERS } = await import('../runner/utils')

/** The argv of the single spawn the adapter performed. */
function lastSpawn(): { exe: string; args: string[]; opts: Record<string, unknown> } {
  expect(spawnMock).toHaveBeenCalledTimes(1)
  const [exe, args, opts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>]
  return { exe, args, opts }
}

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as ChildProcess
    // collectProcess subscribes to these; leaving them undefined is fine.
    return proc
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

// ── LocalRunner ───────────────────────────────────────────────────────────────

describe('LocalRunner.spawnScript', () => {
  it('runs the script through cmd.exe on Windows', () => {
    setPlatform('win32')
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'

    new LocalRunner().spawnScript({ script: 'npm run dev', workDir: process.cwd() })

    const { exe, args, opts } = lastSpawn()
    expect(exe).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(args).toEqual(['/d', '/s', '/c', 'npm run dev'])
    expect(opts.shell).toBe(false)
    expect(opts.cwd).toBe(process.cwd())
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('runs the script through /bin/sh on POSIX', () => {
    setPlatform('linux')

    new LocalRunner().spawnScript({ script: 'npm run dev', workDir: process.cwd() })

    const { exe, args } = lastSpawn()
    expect(exe).toBe('/bin/sh')
    expect(args).toEqual(['-c', 'npm run dev'])
  })

  it('honours localShell: powershell', () => {
    setPlatform('win32')
    process.env.SystemRoot = 'C:\\Windows'

    new LocalRunner().spawnScript({
      script: 'Get-Date',
      workDir: process.cwd(),
      localShell: 'powershell',
    })

    const { exe, args } = lastSpawn()
    expect(exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(['-NonInteractive', '-Command', 'Get-Date'])
  })

  it('passes the caller-supplied env through verbatim', () => {
    setPlatform('linux')
    const env = { CUSTOM: 'yes' }

    new LocalRunner().spawnScript({ script: 'true', workDir: process.cwd(), env })

    expect(lastSpawn().opts.env).toBe(env)
  })

  it('inherits this process cwd when workDir is omitted', () => {
    setPlatform('linux')

    new LocalRunner().spawnScript({ script: 'true' })

    expect(lastSpawn().opts.cwd).toBeUndefined()
  })

  it('refuses a workDir that does not exist', () => {
    setPlatform('linux')

    expect(() => new LocalRunner().spawnScript({
      script: 'true',
      workDir: '/definitely/not/a/real/directory',
    })).toThrow('Working directory does not exist')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('ignores preamble — it is a POSIX-shell concept the local adapter has no shell for', () => {
    setPlatform('linux')

    new LocalRunner().spawnScript({ script: 'true', workDir: process.cwd(), preamble: 'export X=1' })

    expect(lastSpawn().args).toEqual(['-c', 'true'])
  })
})

// ── WslRunner ─────────────────────────────────────────────────────────────────

describe('WslRunner.spawnScript', () => {
  it('wraps the script in bash -ilc with a cd', () => {
    new WslRunner({ distro: 'Ubuntu' }).spawnScript({ script: 'npm run dev', workDir: '/srv/app' })

    const { exe, args, opts } = lastSpawn()
    expect(exe).toBe('wsl')
    expect(args).toEqual(['-d', 'Ubuntu', '--', 'bash', '-ilc', "cd '/srv/app' && npm run dev"])
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('places the preamble before the cd, joined with a semicolon', () => {
    new WslRunner({ distro: 'Ubuntu' }).spawnScript({
      script: 'npm run dev',
      workDir: '/srv/app',
      preamble: 'export WORKTREE_ID=7',
    })

    expect(lastSpawn().args[5]).toBe("export WORKTREE_ID=7; cd '/srv/app' && npm run dev")
  })

  it('emits no cd at all when workDir is omitted', () => {
    new WslRunner({ distro: 'Ubuntu' }).spawnScript({ script: 'command -v claude' })

    expect(lastSpawn().args[5]).toBe('command -v claude')
  })

  it('expands a ~ workDir via $HOME rather than quoting it literally', () => {
    new WslRunner({ distro: 'Ubuntu' }).spawnScript({ script: 'pwd', workDir: '~' })

    expect(lastSpawn().args[5]).toBe('cd "$HOME"\'\' && pwd')
  })
})

// ── SshRunner ─────────────────────────────────────────────────────────────────

const SSH = { host: 'example.test', user: 'alice' }

describe('SshRunner.spawnScript', () => {
  it('wraps the script in bash -lc behind LOAD_NODE_MANAGERS', () => {
    new SshRunner(SSH).spawnScript({ script: 'npm run dev', workDir: '/srv/app' })

    const { exe, args } = lastSpawn()
    expect(exe).toBe('ssh')
    expect(args[args.length - 2]).toBe('alice@example.test')
    const remote = args[args.length - 1]
    expect(remote.startsWith('bash -lc ')).toBe(true)
    expect(remote).toContain(LOAD_NODE_MANAGERS)
    // The whole inner command is single-quoted, so the cd's own quotes arrive
    // as the '\'' escape sequence.
    expect(remote).toContain(String.raw`cd '\''/srv/app'\'' && npm run dev`)
  })

  it('does NOT set BatchMode when streaming', () => {
    new SshRunner(SSH).spawnScript({ script: 'npm run dev', workDir: '/srv/app' })

    expect(lastSpawn().args).not.toContain('BatchMode=yes')
  })

  it('DOES set BatchMode when collecting, so a password prompt fails instead of hanging', () => {
    void new SshRunner(SSH).runScript({ script: 'git status', workDir: '/srv/app' })

    expect(lastSpawn().args).toContain('BatchMode=yes')
  })
})

// ── FakeRunner ────────────────────────────────────────────────────────────────

describe('FakeRunner', () => {
  it('records scripts and replays queued results, so converted modules are testable', async () => {
    const runner = new FakeRunner('wsl')
    runner.queueResult({ stdout: '1.2.3\n', exitCode: 0 })

    const result = await runner.runScript({ script: 'claude --version', workDir: '/srv/app' })

    expect(result.stdout).toBe('1.2.3\n')
    expect(runner.runScriptCommands).toEqual([{ script: 'claude --version', workDir: '/srv/app' }])
    expect(runner.type).toBe('wsl')
  })

  it('keeps spawnScript and spawn in separate logs', () => {
    const runner = new FakeRunner()

    runner.spawnScript({ script: 'echo hi' })
    runner.spawn({ binary: 'echo', args: ['hi'], workDir: '/tmp' })

    expect(runner.spawnedScripts).toHaveLength(1)
    expect(runner.spawned).toHaveLength(1)
  })
})
