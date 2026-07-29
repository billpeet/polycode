/**
 * Characterisation tests for the two transport adapters.
 *
 * `control-rpc-contract.test.ts` regex-scans both files as text: it proves a channel
 * *has* an implementation on both paths, but is structurally unable to notice that the
 * two implementations have drifted in behaviour. These tests close that gap for a
 * representative slice by driving both transports against the same mocked backend and
 * comparing the resulting call sequences.
 *
 * They exist to pin current behaviour before the two dispatch sites are folded into one
 * typed handler map. They should stay green through the fold — that is the point.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNEL_REGISTRY, isRemoteChannel } from '@polycode/shared'

const H = vi.hoisted(() => {
  const log: string[] = []

  const state = {
    location: {
      id: 'loc1',
      project_id: 'p1',
      path: 'C:/repo',
      connection_type: 'local',
      ssh: null,
      wsl: null,
    } as Record<string, unknown> | null,
    project: { id: 'p1', allow_main_branch_commits: true } as Record<string, unknown> | null,
    gitStatus: { branch: 'feature/x' } as Record<string, unknown> | null,
    threadExists: true,
    threadWsl: { use_wsl: false, wsl_distro: null },
  }

  const note = (entry: string): void => { log.push(entry) }

  /** Record a call and return a fixed value. */
  const stub = (label: string, value: unknown = undefined) =>
    (...args: unknown[]): unknown => {
      note(`${label}(${JSON.stringify(args)})`)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value
    }

  /**
   * A module whose every named export is a call-recording stub, so we do not have to
   * enumerate the ~100 exports of db/queries and git just to observe a handful.
   */
  const autoModule = (mod: string, overrides: Record<string, unknown> = {}) =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        if (prop === 'then' || prop === '__esModule') return undefined
        if (prop in overrides) return overrides[prop]
        return stub(`${mod}.${prop}`)
      },
      has: () => true,
    })

  return { log, state, note, stub, autoModule }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: () => true }
})

vi.mock('../db/queries', () => H.autoModule('db', {
  getLocationByPath: H.stub('db.getLocationByPath', () => H.state.location),
  getLocationForThread: H.stub('db.getLocationForThread', () => H.state.location),
  getProjectById: H.stub('db.getProjectById', () => H.state.project),
  getThreadWsl: H.stub('db.getThreadWsl', () => H.state.threadWsl),
  threadExists: H.stub('db.threadExists', () => H.state.threadExists),
  getLastUsedProviderAndModel: () => ({ provider: 'claude', model: 'opus' }),
  listLocations: H.stub('db.listLocations', () => (H.state.location ? [H.state.location] : [])),
}))

vi.mock('../git', () => H.autoModule('git', {
  getCachedGitStatus: H.stub('git.getCachedGitStatus', () => H.state.gitStatus),
  getCachedGitBranch: H.stub('git.getCachedGitBranch', () => Promise.resolve('feature/x')),
}))

vi.mock('../session/manager', () => ({
  sessionManager: H.autoModule('sessionManager', {
    getOrCreate: H.stub('sessionManager.getOrCreate', () => ({
      sendMessage: H.stub('session.sendMessage'),
    })),
  }),
}))

vi.mock('../commands/manager', () => ({ commandManager: H.autoModule('commandManager') }))
vi.mock('../terminal/manager', () => ({ ptyManager: H.autoModule('ptyManager') }))

// The remote-forwarding hop belongs to the ipcMain adapter only. Inactive here, so the
// local implementation runs — which is exactly the path we want to compare.
vi.mock('../remote/client', () => ({
  registerRemoteControlIpcHandlers: () => ({
    invokeIfActive: async () => ({ handled: false, value: undefined }),
  }),
}))

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
/** `ipcMain.on` registrations — a few channels are fire-and-forget rather than invoke. */
const ipcListeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, listener)
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, listener)
    },
  },
  app: { getPath: () => 'C:/tmp', getVersion: () => '0.0.0', isPackaged: false },
  dialog: {},
  shell: {},
  clipboard: {},
  BrowserWindow: class {},
}))

const window = {
  on: () => {},
  minimize: () => {},
  maximize: () => {},
  unmaximize: () => {},
  close: () => {},
  isMaximized: () => false,
  webContents: {
    isDestroyed: () => false,
    send: H.stub('window.send'),
  },
} as unknown as import('electron').BrowserWindow

const { registerIpcHandlers } = await import('../ipc/handlers')
const { handleControlRpc } = await import('../control/control-rpc')

registerIpcHandlers(window)

/** Drive the Electron IPC adapter and return the backend calls it made. */
async function viaIpc(channel: string, args: unknown[]): Promise<string[]> {
  H.log.length = 0
  const listener = ipcHandlers.get(channel)
  if (!listener) throw new Error(`no ipcMain handler registered for ${channel}`)
  await listener({}, ...args)
  return [...H.log]
}

/** Drive the control-RPC adapter and return the backend calls it made. */
async function viaControlRpc(channel: string, args: unknown[]): Promise<string[]> {
  H.log.length = 0
  await handleControlRpc(window, channel, args)
  return [...H.log]
}

beforeEach(() => {
  H.log.length = 0
  H.state.location = {
    id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'local', ssh: null, wsl: null,
  }
  H.state.project = { id: 'p1', allow_main_branch_commits: true }
  H.state.gitStatus = { branch: 'feature/x' }
  H.state.threadExists = true
})

describe('both transports produce identical behaviour', () => {
  it('git:commit — including the main-branch policy check and cache invalidation', async () => {
    const args = ['C:/repo', 'a message']
    const ipc = await viaIpc('git:commit', args)
    const rpc = await viaControlRpc('git:commit', args)

    expect(rpc).toEqual(ipc)
    // Pin the actual sequence, not just that the two agree.
    expect(ipc).toEqual([
      'db.getLocationByPath(["C:/repo"])',
      'db.getLocationByPath(["C:/repo"])',
      'db.getProjectById(["p1"])',
      'git.commitChanges(["C:/repo","a message",null,null])',
      'db.getLocationByPath(["C:/repo"])',
      'git.invalidateGitCache(["C:/repo",null,null])',
    ])
  })

  it('git:commit — both refuse a commit on main when the project disallows it', async () => {
    H.state.project = { id: 'p1', allow_main_branch_commits: false }
    H.state.gitStatus = { branch: 'main' }

    await expect(viaIpc('git:commit', ['C:/repo', 'm'])).rejects.toThrow(
      'Commits are disabled on main for this project',
    )
    await expect(viaControlRpc('git:commit', ['C:/repo', 'm'])).rejects.toThrow(
      'Commits are disabled on main for this project',
    )
  })

  it('threads:updateName', async () => {
    const args = ['t1', 'New name']
    const ipc = await viaIpc('threads:updateName', args)
    const rpc = await viaControlRpc('threads:updateName', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.updateThreadName(["t1","New name"])'])
  })

  it('threads:updateModel — both drop the live session before the write', async () => {
    const args = ['t1', 'sonnet']
    const ipc = await viaIpc('threads:updateModel', args)
    const rpc = await viaControlRpc('threads:updateModel', args)

    expect(rpc).toEqual(ipc)
    expect(ipc[0]).toBe('sessionManager.remove(["t1"])')
  })
})

describe('projects:* — folded into the typed handler map', () => {
  it('projects:delete stops sessions and commands before the row is removed', async () => {
    const ipc = await viaIpc('projects:delete', ['p1'])
    const rpc = await viaControlRpc('projects:delete', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.stopAll([])',
      'commandManager.stopAll([])',
      'db.deleteProject(["p1"])',
    ])
  })

  it('projects:create defaults allowMainBranchCommits to true', async () => {
    const ipc = await viaIpc('projects:create', ['My project', null, undefined])
    const rpc = await viaControlRpc('projects:create', ['My project', null, undefined])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.createProject(["My project",null,true])'])
  })

  it('projects:favicon resolves through the first local location', async () => {
    const ipc = await viaIpc('projects:favicon', ['p1'])
    const rpc = await viaControlRpc('projects:favicon', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc[0]).toBe('db.listLocations(["p1"])')
  })
})

describe('threads:send — the one deliberate divergence', () => {
  const args = ['t1', 'hello', undefined]

  it('both start the session with the same working directory and host config', async () => {
    const ipc = await viaIpc('threads:send', args)
    const rpc = await viaControlRpc('threads:send', args)

    const started = (log: string[]): string | undefined =>
      log.find((entry) => entry.startsWith('sessionManager.getOrCreate'))
    expect(started(rpc)).toBe(started(ipc))
    expect(started(ipc)).toContain('"t1"')

    expect(ipc).toContain('session.sendMessage(["hello",null])')
    expect(rpc).toContain('session.sendMessage(["hello",null])')
  })

  it('only the remote path echoes the message into the local renderer', async () => {
    const ipc = await viaIpc('threads:send', args)
    const rpc = await viaControlRpc('threads:send', args)

    const echoes = (log: string[]): string[] => log.filter((entry) => entry.startsWith('window.send'))

    // The registry documents this asymmetry; nothing currently enforces it.
    expect(CHANNEL_REGISTRY['threads:send']).toMatchObject({ originAware: true })
    expect(echoes(ipc)).toEqual([])
    expect(echoes(rpc)).toHaveLength(1)
    expect(echoes(rpc)[0]).toContain('"source":"remote_client"')
  })

  it('both refuse to send when the thread no longer exists', async () => {
    H.state.threadExists = false

    const ipc = await viaIpc('threads:send', args)
    const rpc = await viaControlRpc('threads:send', args)

    expect(ipc).toContain('sessionManager.remove(["t1"])')
    expect(rpc).toContain('sessionManager.remove(["t1"])')
    expect(ipc.some((entry) => entry.startsWith('session.sendMessage'))).toBe(false)
    expect(rpc.some((entry) => entry.startsWith('session.sendMessage'))).toBe(false)
  })
})

describe('local-only channels are unreachable from the remote transport', () => {
  it('settings:get is registered locally but refused remotely', async () => {
    expect(CHANNEL_REGISTRY['settings:get']).toMatchObject({ local: true, remote: false })
    expect(isRemoteChannel('settings:get')).toBe(false)
    expect(ipcHandlers.has('settings:get')).toBe(true)

    await expect(handleControlRpc(window, 'settings:get', ['k'])).rejects.toThrow(
      'Unsupported remote control channel: settings:get',
    )
  })

  it('every local-only channel is rejected by the control-RPC dispatcher', async () => {
    const localOnly = Object.entries(CHANNEL_REGISTRY)
      .filter(([, capability]) => capability.local && !capability.remote)
      .map(([channel]) => channel)

    expect(localOnly.length).toBeGreaterThan(0)
    for (const channel of localOnly) {
      await expect(handleControlRpc(window, channel, [])).rejects.toThrow(
        `Unsupported remote control channel: ${channel}`,
      )
    }
  })
})
