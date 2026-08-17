/**
 * Characterisation tests for commands/manager.ts's spawn, written as it moved
 * behind the Runner seam. The module had no tests before.
 *
 * Scope is deliberately the spawn only. manager.ts also owns real machinery this
 * card does not touch — the lifecycle queue, graceful-then-forced shutdown, the
 * log ring buffer and process-tree port discovery — and conflating the two would
 * make it unclear which of them a failure is about.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { FakeRunner } from '../driver/runner/fake'

const createRunnerMock = vi.fn()
const getCommandById = vi.fn()
const getLocationById = vi.fn()

vi.mock('../driver/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../driver/runner')>()
  return { ...actual, createRunner: (...args: unknown[]) => createRunnerMock(...args) }
})

vi.mock('../db/queries', () => ({
  getCommandById: (...args: unknown[]) => getCommandById(...args),
  getLocationById: (...args: unknown[]) => getLocationById(...args),
  listCommands: () => [],
}))

vi.mock('../app-events', () => ({ emitAppEvent: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: class {} }))

const SSH = { host: 'example.test', user: 'alice' }
const WSL = { distro: 'Ubuntu' }

/**
 * FakeRunner returns a bare EventEmitter. manager.ts's stopImpl inspects
 * exitCode/signalCode and subscribes to 'close', so give it a process that
 * reports itself already exited — start() awaits stopImpl first.
 */
function fakeRunner(type: 'local' | 'wsl' | 'ssh'): FakeRunner {
  const runner = new FakeRunner(type)
  const proc = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: 0,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as ChildProcess
  runner.spawnScript = ((cmd) => {
    runner.spawnedScripts.push(cmd)
    return proc
  }) as FakeRunner['spawnScript']
  createRunnerMock.mockReturnValue(runner)
  return runner
}

function activeFakeRunner(type: 'local' | 'wsl' | 'ssh'): { runner: FakeRunner; proc: ChildProcess } {
  const runner = new FakeRunner(type)
  const emitter = new EventEmitter()
  const proc = Object.assign(emitter, {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess
  runner.spawnScript = ((cmd) => {
    runner.spawnedScripts.push(cmd)
    return proc
  }) as FakeRunner['spawnScript']
  createRunnerMock.mockReturnValue(runner)
  return { runner, proc }
}

async function loadManager(): Promise<typeof import('../commands/manager')> {
  vi.resetModules()
  return import('../commands/manager')
}

function givenCommand(command: string, shell?: string): void {
  getCommandById.mockReturnValue({ id: 'c1', command, shell, cwd: null })
}

beforeEach(() => {
  createRunnerMock.mockReset()
  getCommandById.mockReset()
  getLocationById.mockReset()
})

describe('CommandManager.start — transport selection', () => {
  it('runs a wsl location through a wsl Runner', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'wsl', wsl: WSL, path: '/srv/app' })
    const runner = fakeRunner('wsl')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(createRunnerMock).toHaveBeenCalledWith({ wsl: WSL })
    expect(runner.spawnedScripts[0]).toMatchObject({ script: 'npm run dev', workDir: '/srv/app' })
  })

  it('runs an ssh location through an ssh Runner', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'ssh', ssh: SSH, path: '/srv/app' })
    const runner = fakeRunner('ssh')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(createRunnerMock).toHaveBeenCalledWith({ ssh: SSH })
    expect(runner.spawnedScripts[0].script).toBe('npm run dev')
  })

  it('runs a local location through a local Runner', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'local', path: process.cwd() })
    fakeRunner('local')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(createRunnerMock).toHaveBeenCalledWith({})
  })

  it('falls back to local when the connection type claims wsl but no config exists', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'wsl', wsl: null, path: process.cwd() })
    fakeRunner('local')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(createRunnerMock).toHaveBeenCalledWith({})
  })
})

describe('CommandManager.start — WORKTREE_ID', () => {
  it('exports WORKTREE_ID in the remote preamble for a worktree location', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({
      id: 'l1', connection_type: 'wsl', wsl: WSL, path: '/srv/app',
      is_worktree: 1, worktree_id: 7,
    })
    const runner = fakeRunner('wsl')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].preamble).toBe('export WORKTREE_ID=7')
    expect(runner.spawnedScripts[0].env?.WORKTREE_ID).toBe('7')
  })

  it('unsets WORKTREE_ID for a non-worktree location, so a stale one cannot leak in', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'wsl', wsl: WSL, path: '/srv/app' })
    const runner = fakeRunner('wsl')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].preamble).toBe('unset WORKTREE_ID')
    expect(runner.spawnedScripts[0].env).not.toHaveProperty('WORKTREE_ID')
  })
})

describe('CommandManager.start — shell and working directory', () => {
  it('asks for PowerShell when the command definition says so', async () => {
    givenCommand('Get-Date', 'powershell')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'local', path: process.cwd() })
    const runner = fakeRunner('local')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].localShell).toBe('powershell')
  })

  it('asks for the default shell otherwise', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'local', path: process.cwd() })
    const runner = fakeRunner('local')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].localShell).toBe('default')
  })

  it('drops a local cwd that does not exist rather than failing the spawn', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({
      id: 'l1', connection_type: 'local', path: '/definitely/not/a/real/directory',
    })
    const runner = fakeRunner('local')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].workDir).toBeUndefined()
  })

  it('sends a remote command with no path to the login shell home', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'wsl', wsl: WSL, path: null })
    const runner = fakeRunner('wsl')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].workDir).toBe('~')
  })

  it('joins a relative cwd onto the location path with POSIX separators when remote', async () => {
    getCommandById.mockReturnValue({ id: 'c1', command: 'npm test', cwd: 'packages/api' })
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'ssh', ssh: SSH, path: '/srv/app' })
    const runner = fakeRunner('ssh')
    const { commandManager } = await loadManager()

    await commandManager.start('c1', 'l1')

    expect(runner.spawnedScripts[0].workDir).toBe('/srv/app/packages/api')
  })
})

describe('CommandManager cleanup', () => {
  it('lets callers await all commands at a location exiting', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'local', path: process.cwd() })
    const { proc } = activeFakeRunner('local')
    const { commandManager } = await loadManager()
    await commandManager.start('c1', 'l1')

    let settled = false
    const stopped = commandManager.stopAllForLocation('l1').then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    Object.assign(proc, { exitCode: 0 })
    proc.emit('close', 0)
    await stopped

    expect(commandManager.getStatus('c1', 'l1')).toBe('stopped')
  })

  it('lets app shutdown await every command exiting', async () => {
    givenCommand('npm run dev')
    getLocationById.mockReturnValue({ id: 'l1', connection_type: 'local', path: process.cwd() })
    const { proc } = activeFakeRunner('local')
    const { commandManager } = await loadManager()
    await commandManager.start('c1', 'l1')

    let settled = false
    const stopped = commandManager.stopAll().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    Object.assign(proc, { exitCode: 0 })
    proc.emit('close', 0)
    await stopped

    expect(commandManager.hasRunning()).toBe(false)
  })
})
