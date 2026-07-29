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

  /**
   * Render an argument list so `undefined` and `null` are distinguishable.
   *
   * Plain `JSON.stringify` maps `undefined` array elements to `null`, which made the
   * recorded log lie about exactly the axis the two legacy implementations most often
   * differed on — one path coalescing an optional to `null` while the other passed it
   * raw. Two folds in a row hit that blind spot. Argument slots are rendered explicitly;
   * `undefined` nested inside an object is still dropped by JSON.stringify, which has not
   * mattered so far.
   */
  const renderArgs = (args: unknown[]): string =>
    `[${args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg))).join(',')}]`

  /** Record a call and return a fixed value. */
  const stub = (label: string, value: unknown = undefined) =>
    (...args: unknown[]): unknown => {
      note(`${label}(${renderArgs(args)})`)
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

  /**
   * A stub whose promise settles on a *macrotask*, not a microtask. Awaiting the handler's
   * own result therefore cannot accidentally drain it: the `:settled` entry appears in the
   * call log only if the handler genuinely awaited (or returned) the callee's promise.
   */
  const settlesLate = (label: string) =>
    stub(label, () => new Promise((resolve) => {
      setTimeout(() => { note(`${label}:settled`); resolve(undefined) }, 0)
    }))

  return { log, state, note, stub, autoModule, settlesLate }
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
  // Sentinel returns for functions currently declared `: void`. Real code ignores these,
  // but they let us assert that a handler passes its callee's result through rather than
  // discarding it — see "handlers pass the callee's result through" below.
  updateLocation: H.stub('db.updateLocation', 'RET_updateLocation'),
  deleteLocation: H.stub('db.deleteLocation', 'RET_deleteLocation'),
  checkoutLocation: H.stub('db.checkoutLocation', 'RET_checkoutLocation'),
  returnLocationToPool: H.stub('db.returnLocationToPool', 'RET_returnLocationToPool'),
  archiveProject: H.stub('db.archiveProject', 'RET_archiveProject'),
  unarchiveProject: H.stub('db.unarchiveProject', 'RET_unarchiveProject'),
  deleteProject: H.stub('db.deleteProject', 'RET_deleteProject'),
  listCommands: H.stub('db.listCommands', () => [{ id: 'cmd1', name: 'dev' }]),
  createCommand: H.stub('db.createCommand', 'RET_createCommand'),
  updateCommand: H.stub('db.updateCommand', 'RET_updateCommand'),
  deleteCommand: H.stub('db.deleteCommand', 'RET_deleteCommand'),
}))

vi.mock('../project-admin', () => H.autoModule('projectAdmin'))

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

vi.mock('../commands/manager', () => ({
  commandManager: H.autoModule('commandManager', {
    start: H.settlesLate('commandManager.start'),
    stop: H.settlesLate('commandManager.stop'),
    restart: H.settlesLate('commandManager.restart'),
    getStatus: H.stub('commandManager.getStatus', 'running'),
    getLogs: H.stub('commandManager.getLogs', [{ line: 'listening on 3000', stream: 'stdout' }]),
    getPid: H.stub('commandManager.getPid', 4242),
    getPorts: H.stub('commandManager.getPorts', [3000, 3001]),
  }),
}))
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

/** Drive the Electron IPC adapter and return the handler's resolved value. */
async function resultViaIpc(channel: string, args: unknown[]): Promise<unknown> {
  const listener = ipcHandlers.get(channel)
  if (!listener) throw new Error(`no ipcMain handler registered for ${channel}`)
  return listener({}, ...args)
}

/** Drive the control-RPC adapter and return the handler's resolved value. */
function resultViaControlRpc(channel: string, args: unknown[]): Promise<unknown> {
  return handleControlRpc(window, channel, args)
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

describe('locations:* — both transports agree', () => {
  it('locations:list', async () => {
    const ipc = await viaIpc('locations:list', ['p1'])
    const rpc = await viaControlRpc('locations:list', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.listLocations(["p1"])'])
  })

  it('locations:create forwards every argument in order', async () => {
    const ssh = { host: 'h', user: 'u', port: 22, keyPath: null }
    const args = ['p1', 'Main', 'ssh', '/srv/repo', 'pool1', ssh, null]
    const ipc = await viaIpc('locations:create', args)
    const rpc = await viaControlRpc('locations:create', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      `db.createLocation(["p1","Main","ssh","/srv/repo","pool1",${JSON.stringify(ssh)},null])`,
    ])
  })

  it('locations:create with the optional pool/ssh/wsl arguments omitted', async () => {
    const args = ['p1', 'Main', 'local', 'C:/repo']
    const ipc = await viaIpc('locations:create', args)
    const rpc = await viaControlRpc('locations:create', args)

    // The control-RPC path coalesces the three optionals with `?? null` and the IPC path
    // passes them through raw. Both reach db/queries.ts, which coalesces them again
    // before binding — so the observable call is the same either way.
    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.createLocation(["p1","Main","local","C:/repo",undefined,undefined,undefined])'])
  })

  it('locations:update forwards every argument in order', async () => {
    const wsl = { distro: 'Ubuntu' }
    const args = ['loc1', 'Renamed', 'wsl', '/home/me/repo', null, null, wsl]
    const ipc = await viaIpc('locations:update', args)
    const rpc = await viaControlRpc('locations:update', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      `db.updateLocation(["loc1","Renamed","wsl","/home/me/repo",null,null,${JSON.stringify(wsl)}])`,
    ])
  })

  it('locations:update with the optional pool/ssh/wsl arguments omitted', async () => {
    const args = ['loc1', 'Renamed', 'local', 'C:/repo']
    const ipc = await viaIpc('locations:update', args)
    const rpc = await viaControlRpc('locations:update', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.updateLocation(["loc1","Renamed","local","C:/repo",undefined,undefined,undefined])'])
  })

  it('locations:delete', async () => {
    const ipc = await viaIpc('locations:delete', ['loc1'])
    const rpc = await viaControlRpc('locations:delete', ['loc1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.deleteLocation(["loc1"])'])
  })

  it('locations:createWorktree passes the omitted label straight through', async () => {
    const ipc = await viaIpc('locations:createWorktree', ['loc1'])
    const rpc = await viaControlRpc('locations:createWorktree', ['loc1'])

    expect(rpc).toEqual(ipc)
    // NOTE: the log renders the second argument as `null` only because the recorder uses
    // JSON.stringify, which maps `undefined` to `null`. The real value passed is
    // `undefined` — control-rpc.ts used to coalesce it to `null` and no longer does.
    // That is safe because project-admin.ts:161 does `label || currentBranch || 'worktree'`,
    // and both `null` and `undefined` are falsy. This harness cannot tell the two apart,
    // so do not read this assertion as evidence about which one arrives.
    expect(ipc).toEqual(['projectAdmin.createLocalWorktree(["loc1",undefined])'])
  })

  it('locations:removeWorktree', async () => {
    const ipc = await viaIpc('locations:removeWorktree', ['loc1'])
    const rpc = await viaControlRpc('locations:removeWorktree', ['loc1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['projectAdmin.removeWorktreeLocation(["loc1"])'])
  })

  it('locations:clone', async () => {
    const args = ['p1', 'Main', 'https://example.test/r.git', 'C:/repo']
    const ipc = await viaIpc('locations:clone', args)
    const rpc = await viaControlRpc('locations:clone', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'projectAdmin.cloneLocation(["p1","Main","https://example.test/r.git","C:/repo"])',
    ])
  })

  it('locations:suggestPath', async () => {
    const args = ['C:/src', 'polycode']
    const ipc = await viaIpc('locations:suggestPath', args)
    const rpc = await viaControlRpc('locations:suggestPath', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['projectAdmin.suggestUniquePath(["C:/src","polycode"])'])
  })

  it('locations:checkout and locations:returnToPool', async () => {
    expect(await viaControlRpc('locations:checkout', ['loc1'])).toEqual(
      await viaIpc('locations:checkout', ['loc1']),
    )
    expect(await viaIpc('locations:checkout', ['loc1'])).toEqual(['db.checkoutLocation(["loc1"])'])

    expect(await viaControlRpc('locations:returnToPool', ['loc1'])).toEqual(
      await viaIpc('locations:returnToPool', ['loc1']),
    )
    expect(await viaIpc('locations:returnToPool', ['loc1'])).toEqual([
      'db.returnLocationToPool(["loc1"])',
    ])
  })

  it('locations:pathExists returns the filesystem answer and touches nothing else', async () => {
    // Asserting the empty call log alone would pass even if the handler were deleted, so
    // assert the returned value — that is the whole behaviour of this channel.
    expect(await resultViaIpc('locations:pathExists', ['C:/repo'])).toBe(true)
    expect(await resultViaControlRpc('locations:pathExists', ['C:/repo'])).toBe(true)

    const ipc = await viaIpc('locations:pathExists', ['C:/repo'])
    const rpc = await viaControlRpc('locations:pathExists', ['C:/repo'])
    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([])
  })
})

describe('commands:* — both transports agree', () => {
  it('commands:list', async () => {
    const ipc = await viaIpc('commands:list', ['p1'])
    const rpc = await viaControlRpc('commands:list', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.listCommands(["p1"])'])
    expect(await resultViaIpc('commands:list', ['p1'])).toEqual([{ id: 'cmd1', name: 'dev' }])
    expect(await resultViaControlRpc('commands:list', ['p1'])).toEqual([{ id: 'cmd1', name: 'dev' }])
  })

  it('commands:create forwards every argument in order', async () => {
    const args = ['p1', 'dev', 'pnpm dev', 'C:/repo/app', 'pwsh', true]
    const ipc = await viaIpc('commands:create', args)
    const rpc = await viaControlRpc('commands:create', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.createCommand(["p1","dev","pnpm dev","C:/repo/app","pwsh",true])'])
  })

  it('commands:create defaults an omitted runOnWorktreeCreate to false', async () => {
    const args = ['p1', 'dev', 'pnpm dev']
    const ipc = await viaIpc('commands:create', args)
    const rpc = await viaControlRpc('commands:create', args)

    expect(rpc).toEqual(ipc)
    // NOTE: `cwd`/`shell` render as `null` only because the recorder uses JSON.stringify,
    // which maps `undefined` to `null`; the real values are `undefined`. That is harmless
    // here — db/queries.ts coalesces both with `?? null` before binding *and* in the
    // returned object.
    //
    // The sixth slot shows `false` rather than `null`, so this assertion does pin the
    // coalesce — but for an *omitted* argument the coalesce is behaviourally redundant:
    // createCommand's `runOnWorktreeCreate = false` parameter default would fire anyway.
    // The next test is the one that pins behaviour rather than spelling.
    expect(ipc).toEqual(['db.createCommand(["p1","dev","pnpm dev",undefined,undefined,false])'])
  })

  it('commands:create coalesces an explicit null runOnWorktreeCreate to false', async () => {
    // `null` does NOT trigger createCommand's `= false` parameter default, which fires on
    // `undefined` only — so this coalesce is what keeps the returned ProjectCommand's
    // `run_on_worktree_create` a boolean rather than a null.
    //
    // Note the null arrives explicitly, not by omission: JSON round-trips an *omitted*
    // trailing argument as a shorter array (still `undefined` on arrival). It is an
    // explicitly-`undefined` element that JSON.stringify turns into `null`.
    const args = ['p1', 'dev', 'pnpm dev', null, null, null]
    const ipc = await viaIpc('commands:create', args)
    const rpc = await viaControlRpc('commands:create', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.createCommand(["p1","dev","pnpm dev",null,null,false])'])
  })

  it('commands:update forwards every argument in order', async () => {
    const args = ['cmd1', 'dev', 'pnpm dev', null, null, true]
    const ipc = await viaIpc('commands:update', args)
    const rpc = await viaControlRpc('commands:update', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.updateCommand(["cmd1","dev","pnpm dev",null,null,true])'])
  })

  it('commands:update coalesces both an omitted and an explicit null runOnWorktreeCreate', async () => {
    // These two inputs are genuinely different and the recorder now shows it: omitted
    // optionals stay `undefined` in slots 4-5, explicit nulls stay `null`. Both end up
    // `false` in slot 6, which is the behaviour under test.
    expect(await viaIpc('commands:update', ['cmd1', 'dev', 'pnpm dev'])).toEqual([
      'db.updateCommand(["cmd1","dev","pnpm dev",undefined,undefined,false])',
    ])
    expect(await viaControlRpc('commands:update', ['cmd1', 'dev', 'pnpm dev'])).toEqual([
      'db.updateCommand(["cmd1","dev","pnpm dev",undefined,undefined,false])',
    ])
    expect(await viaIpc('commands:update', ['cmd1', 'dev', 'pnpm dev', null, null, null])).toEqual([
      'db.updateCommand(["cmd1","dev","pnpm dev",null,null,false])',
    ])
  })

  it('commands:delete stops every running instance before the row is removed', async () => {
    const ipc = await viaIpc('commands:delete', ['cmd1'])
    const rpc = await viaControlRpc('commands:delete', ['cmd1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'commandManager.stopAllInstances(["cmd1"])',
      'db.deleteCommand(["cmd1"])',
    ])
  })

  it('commands:start awaits the manager rather than floating its promise', async () => {
    const args = ['cmd1', 'loc1']
    const ipc = await viaIpc('commands:start', args)
    const rpc = await viaControlRpc('commands:start', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['commandManager.start(["cmd1","loc1"])', 'commandManager.start:settled'])
  })

  it('commands:stop and commands:restart also await the manager', async () => {
    const args = ['cmd1', 'loc1']

    expect(await viaControlRpc('commands:stop', args)).toEqual(await viaIpc('commands:stop', args))
    expect(await viaIpc('commands:stop', args)).toEqual([
      'commandManager.stop(["cmd1","loc1"])', 'commandManager.stop:settled',
    ])

    expect(await viaControlRpc('commands:restart', args)).toEqual(
      await viaIpc('commands:restart', args),
    )
    expect(await viaIpc('commands:restart', args)).toEqual([
      'commandManager.restart(["cmd1","loc1"])', 'commandManager.restart:settled',
    ])
  })

  it('the four read channels return the manager\'s answer untouched', async () => {
    const args = ['cmd1', 'loc1']
    const cases: Array<[channel: string, expected: unknown]> = [
      ['commands:getStatus', 'running'],
      ['commands:getLogs', [{ line: 'listening on 3000', stream: 'stdout' }]],
      ['commands:getPid', 4242],
      ['commands:getPorts', [3000, 3001]],
    ]

    for (const [channel, expected] of cases) {
      expect(await resultViaIpc(channel, args)).toEqual(expected)
      expect(await resultViaControlRpc(channel, args)).toEqual(expected)

      const method = channel.slice('commands:'.length)
      const ipc = await viaIpc(channel, args)
      expect(await viaControlRpc(channel, args)).toEqual(ipc)
      expect(ipc).toEqual([`commandManager.${method}(["cmd1","loc1"])`])
    }
  })
})

/**
 * Guards a regression the type system cannot see.
 *
 * These channels call functions declared `: void`, and the contract's result type is
 * `void`, so a handler that calls-and-discards type-checks exactly as well as one that
 * returns. The difference only bites if a callee later becomes `async`: a discarding body
 * floats the promise and the transport replies before the work finishes.
 *
 * The pre-fold implementations all wrote `return updateLocation(...)`. These assertions
 * pin that, so the safer form cannot be quietly lost.
 */
describe("handlers pass the callee's result through", () => {
  const cases: Array<[channel: string, args: unknown[], expected: string]> = [
    ['locations:update', ['loc1', 'L', 'local', 'C:/repo'], 'RET_updateLocation'],
    ['locations:delete', ['loc1'], 'RET_deleteLocation'],
    ['locations:checkout', ['loc1'], 'RET_checkoutLocation'],
    ['locations:returnToPool', ['loc1'], 'RET_returnLocationToPool'],
    ['projects:archive', ['p1'], 'RET_archiveProject'],
    ['projects:unarchive', ['p1'], 'RET_unarchiveProject'],
    ['projects:delete', ['p1'], 'RET_deleteProject'],
    ['commands:update', ['cmd1', 'dev', 'pnpm dev'], 'RET_updateCommand'],
    ['commands:delete', ['cmd1'], 'RET_deleteCommand'],
  ]

  for (const [channel, args, expected] of cases) {
    it(`${channel} returns its callee's value on both transports`, async () => {
      expect(await resultViaIpc(channel, args)).toBe(expected)
      expect(await resultViaControlRpc(channel, args)).toBe(expected)
    })
  }
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

    expect(ipc).toContain('session.sendMessage(["hello",undefined])')
    expect(rpc).toContain('session.sendMessage(["hello",undefined])')
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
