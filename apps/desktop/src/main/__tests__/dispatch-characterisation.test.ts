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
    /** Whether `sessionManager.get` finds a live session for the thread. */
    hasSession: true,
    /** What that session reports from `isRunning()`. */
    sessionRunning: false,
    /** What the mocked `existsSync` answers — drives `getLocalPathError`. */
    pathExists: true,
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
  const settlesLate = (label: string, value: unknown = undefined) =>
    stub(label, () => new Promise((resolve) => {
      setTimeout(() => { note(`${label}:settled`); resolve(value) }, 0)
    }))

  /**
   * The one `Session` both transports reach, whether via `get` or `getOrCreate`.
   *
   * A single shared instance rather than a fresh object per call: the thread channels are
   * about *which* session methods run in *which* order, and one recorder per method makes
   * that directly readable in the call log.
   */
  const session = {
    isRunning: stub('session.isRunning', () => state.sessionRunning),
    start: stub('session.start'),
    stop: stub('session.stop'),
    sendMessage: stub('session.sendMessage'),
    getPid: stub('session.getPid', 4321),
    approvePlan: stub('session.approvePlan'),
    rejectPlan: stub('session.rejectPlan'),
    getPendingQuestions: stub('session.getPendingQuestions', [{ id: 'q1', text: 'Which one?' }]),
    answerQuestion: stub('session.answerQuestion'),
    getPendingPermissions: stub('session.getPendingPermissions', [{ requestId: 'perm1' }]),
    approvePermissions: stub('session.approvePermissions'),
    denyPermissions: stub('session.denyPermissions'),
    executePlanInNewContext: stub('session.executePlanInNewContext'),
    // settlesLate, not stub: these were `await`-ed pre-fold, and a plain stub returning a
    // non-thenable makes `(await x) ?? []` and `x ?? []` indistinguishable.
    listBackgroundTerminals: settlesLate('session.listBackgroundTerminals', [{ itemId: 'bg1' }]),
    terminateBackgroundTerminal: settlesLate('session.terminateBackgroundTerminal', true),
    cleanBackgroundTerminals: settlesLate('session.cleanBackgroundTerminals'),
  }

  return { log, state, note, stub, autoModule, settlesLate, session }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: () => H.state.pathExists }
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
    getOrCreate: H.stub('sessionManager.getOrCreate', () => H.session),
    // `get` returns `undefined` for a thread with no live session — the branch several
    // thread channels take after a restart, and the one `?.` silently absorbs.
    get: H.stub('sessionManager.get', () => (H.state.hasSession ? H.session : undefined)),
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
  H.state.hasSession = true
  H.state.sessionRunning = false
  H.state.pathExists = true
})

/**
 * `sessionManager.getOrCreate(threadId, cwd, window, ssh, wsl)` as the recorder renders it.
 * Spelled out rather than substring-matched so the argument *order* is pinned, but the
 * window is interpolated so the assertion does not break when the test double grows a
 * field.
 */
const getOrCreateEntry = (threadId: string, cwd = 'C:/repo'): string =>
  `sessionManager.getOrCreate(["${threadId}","${cwd}",${JSON.stringify(window)},null,null])`

/**
 * SSH and WSL configs that render differently from each other.
 *
 * The default fixture has `ssh: null, wsl: null`, which makes the two argument slots
 * indistinguishable — transposing `getSshConfigForThread` and `getWslConfigForThread` in a
 * handler passes every assertion in this file. Tests that care about which config lands in
 * which slot install these instead.
 */
const DISTINCT_SSH = { host: 'ssh.example.test', user: 'me' }
const DISTINCT_WSL = { distro: 'Ubuntu' }

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

describe('threads:* session lifecycle and interaction — both transports agree', () => {
  it('threads:start resolves the host context, then starts an idle session', async () => {
    const ipc = await viaIpc('threads:start', ['t1'])
    const rpc = await viaControlRpc('threads:start', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'db.threadExists(["t1"])',
      // getLocalPathError
      'db.getLocationForThread(["t1"])',
      // getEffectiveWorkingDir
      'db.getLocationForThread(["t1"])',
      'db.getThreadWsl(["t1"])',
      // getSshConfigForThread
      'db.getLocationForThread(["t1"])',
      // getWslConfigForThread
      'db.getLocationForThread(["t1"])',
      'db.getThreadWsl(["t1"])',
      getOrCreateEntry('t1'),
      'session.isRunning([])',
      'session.start([])',
    ])
  })

  it('threads:start does not re-start an already-running session', async () => {
    H.state.sessionRunning = true

    const ipc = await viaIpc('threads:start', ['t1'])
    const rpc = await viaControlRpc('threads:start', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toContain('session.isRunning([])')
    expect(ipc).not.toContain('session.start([])')
  })

  it('threads:start is a no-op for a thread that no longer exists', async () => {
    H.state.threadExists = false

    const ipc = await viaIpc('threads:start', ['t1'])
    const rpc = await viaControlRpc('threads:start', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.threadExists(["t1"])'])
  })

  it('threads:start refuses when the local working directory is missing', async () => {
    H.state.pathExists = false

    await expect(viaIpc('threads:start', ['t1'])).rejects.toThrow(
      'Directory not found: "C:/repo"',
    )
    await expect(viaControlRpc('threads:start', ['t1'])).rejects.toThrow(
      'Directory not found: "C:/repo"',
    )
  })

  it('threads:stop stops a running session', async () => {
    H.state.sessionRunning = true

    const ipc = await viaIpc('threads:stop', ['t1', true])
    const rpc = await viaControlRpc('threads:stop', ['t1', true])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.get(["t1"])',
      'session.isRunning([])',
      'session.stop([true])',
    ])
  })

  it('threads:stop treats an omitted or null cleanBackgroundTerminals as false', async () => {
    H.state.sessionRunning = true

    // Omitted: the IPC path had a `= false` *parameter default*, the control-RPC path had
    // nothing. Both are moot — the shared `=== true` normalisation absorbs `undefined`,
    // `null` and `false` alike, so the default could never change the outcome.
    expect(await viaIpc('threads:stop', ['t1'])).toEqual([
      'sessionManager.get(["t1"])', 'session.isRunning([])', 'session.stop([false])',
    ])
    expect(await viaControlRpc('threads:stop', ['t1'])).toEqual([
      'sessionManager.get(["t1"])', 'session.isRunning([])', 'session.stop([false])',
    ])
    // Explicit null — reachable over the remote transport, where args are JSON.
    expect(await viaIpc('threads:stop', ['t1', null])).toEqual([
      'sessionManager.get(["t1"])', 'session.isRunning([])', 'session.stop([false])',
    ])
    expect(await viaControlRpc('threads:stop', ['t1', null])).toEqual([
      'sessionManager.get(["t1"])', 'session.isRunning([])', 'session.stop([false])',
    ])
    // A non-boolean truthy value is the ONLY input that distinguishes the `=== true`
    // normalisation from plain truthiness, and it is reachable over JSON. Without this
    // case, rewriting `cleanBackgroundTerminals === true` as `!!cleanBackgroundTerminals`
    // passes every other assertion here.
    expect(await viaControlRpc('threads:stop', ['t1', 1])).toEqual([
      'sessionManager.get(["t1"])', 'session.isRunning([])', 'session.stop([false])',
    ])
    expect(await viaControlRpc('threads:stop', ['t1', 'false'])).toEqual([
      'sessionManager.get(["t1"])', 'session.isRunning([])', 'session.stop([false])',
    ])
  })

  it('threads:stop force-resets a thread with no live session', async () => {
    H.state.hasSession = false

    const ipc = await viaIpc('threads:stop', ['t1'])
    const rpc = await viaControlRpc('threads:stop', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.get(["t1"])',
      'db.updateThreadStatus(["t1","idle"])',
      'window.send(["thread:status:t1","idle"])',
      'window.send(["thread:pid:t1",null])',
    ])
  })

  it('threads:reset drops the session and clears the stuck status', async () => {
    const ipc = await viaIpc('threads:reset', ['t1'])
    const rpc = await viaControlRpc('threads:reset', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.reset(["t1"])',
      'db.updateThreadStatus(["t1","idle"])',
      'window.send(["thread:status:t1","idle"])',
      'window.send(["thread:pid:t1",null])',
    ])
  })

  it('threads:getPid returns the session pid, or null with no session', async () => {
    expect(await resultViaIpc('threads:getPid', ['t1'])).toBe(4321)
    expect(await resultViaControlRpc('threads:getPid', ['t1'])).toBe(4321)

    H.state.hasSession = false
    expect(await resultViaIpc('threads:getPid', ['t1'])).toBe(null)
    expect(await resultViaControlRpc('threads:getPid', ['t1'])).toBe(null)
  })

  it('threads:executePlanInNewContext creates the session and hands the plan over', async () => {
    const ipc = await viaIpc('threads:executePlanInNewContext', ['t1'])
    const rpc = await viaControlRpc('threads:executePlanInNewContext', ['t1'])

    expect(rpc).toEqual(ipc)
    // No getLocalPathError here — unlike threads:start and threads:send. Preserved as-is.
    expect(ipc).toEqual([
      'db.threadExists(["t1"])',
      'db.getLocationForThread(["t1"])',
      'db.getThreadWsl(["t1"])',
      'db.getLocationForThread(["t1"])',
      'db.getLocationForThread(["t1"])',
      'db.getThreadWsl(["t1"])',
      getOrCreateEntry('t1'),
      'session.executePlanInNewContext([])',
    ])
  })

  it('threads:approvePlan and threads:rejectPlan reach the live session only', async () => {
    for (const [channel, method] of [
      ['threads:approvePlan', 'approvePlan'],
      ['threads:rejectPlan', 'rejectPlan'],
    ] as const) {
      const ipc = await viaIpc(channel, ['t1'])
      expect(await viaControlRpc(channel, ['t1'])).toEqual(ipc)
      expect(ipc).toEqual(['sessionManager.get(["t1"])', `session.${method}([])`])

      H.state.hasSession = false
      expect(await viaIpc(channel, ['t1'])).toEqual(['sessionManager.get(["t1"])'])
      expect(await viaControlRpc(channel, ['t1'])).toEqual(['sessionManager.get(["t1"])'])
      H.state.hasSession = true
    }
  })

  it('threads:getQuestions returns the pending questions, or [] with no session', async () => {
    expect(await resultViaIpc('threads:getQuestions', ['t1'])).toEqual([
      { id: 'q1', text: 'Which one?' },
    ])
    expect(await resultViaControlRpc('threads:getQuestions', ['t1'])).toEqual([
      { id: 'q1', text: 'Which one?' },
    ])

    H.state.hasSession = false
    expect(await resultViaIpc('threads:getQuestions', ['t1'])).toEqual([])
    expect(await resultViaControlRpc('threads:getQuestions', ['t1'])).toEqual([])
  })

  it('threads:answerQuestion forwards all three answer arguments in order', async () => {
    const args = ['t1', { q1: 'yes' }, { q1: 'because' }, 'general']
    const ipc = await viaIpc('threads:answerQuestion', args)
    const rpc = await viaControlRpc('threads:answerQuestion', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.get(["t1"])',
      'session.answerQuestion([{"q1":"yes"},{"q1":"because"},"general"])',
    ])
  })

  it('threads:getPendingPermissions returns the queue, or [] with no session', async () => {
    expect(await resultViaIpc('threads:getPendingPermissions', ['t1'])).toEqual([
      { requestId: 'perm1' },
    ])
    expect(await resultViaControlRpc('threads:getPendingPermissions', ['t1'])).toEqual([
      { requestId: 'perm1' },
    ])

    H.state.hasSession = false
    expect(await resultViaIpc('threads:getPendingPermissions', ['t1'])).toEqual([])
    expect(await resultViaControlRpc('threads:getPendingPermissions', ['t1'])).toEqual([])
  })

  it('threads:approve/denyPermissions pass requestId through raw, omitted included', async () => {
    for (const [channel, method] of [
      ['threads:approvePermissions', 'approvePermissions'],
      ['threads:denyPermissions', 'denyPermissions'],
    ] as const) {
      const withId = await viaIpc(channel, ['t1', 'perm1'])
      expect(await viaControlRpc(channel, ['t1', 'perm1'])).toEqual(withId)
      expect(withId).toEqual(['sessionManager.get(["t1"])', `session.${method}(["perm1"])`])

      // Omitted requestId means "the first pending request". Neither path coalesces it,
      // and Session.getTargetPermissionRequest tests it for truthiness, so `undefined`
      // and `null` are equivalent there — nothing to normalise.
      const without = await viaIpc(channel, ['t1'])
      expect(await viaControlRpc(channel, ['t1'])).toEqual(without)
      expect(without).toEqual(['sessionManager.get(["t1"])', `session.${method}([undefined])`])
    }
  })

  it('threads:backgroundTerminals:list returns the session answer, or [] with no session', async () => {
    const ipc = await viaIpc('threads:backgroundTerminals:list', ['t1'])
    expect(await viaControlRpc('threads:backgroundTerminals:list', ['t1'])).toEqual(ipc)
    // The `:settled` entry proves the handler genuinely awaited the promise rather than
    // returning `[]` while the lookup was still in flight.
    expect(ipc).toEqual([
      'sessionManager.get(["t1"])',
      'session.listBackgroundTerminals([])',
      'session.listBackgroundTerminals:settled',
    ])

    expect(await resultViaIpc('threads:backgroundTerminals:list', ['t1'])).toEqual([
      { itemId: 'bg1' },
    ])
    expect(await resultViaControlRpc('threads:backgroundTerminals:list', ['t1'])).toEqual([
      { itemId: 'bg1' },
    ])

    H.state.hasSession = false
    expect(await resultViaIpc('threads:backgroundTerminals:list', ['t1'])).toEqual([])
    expect(await resultViaControlRpc('threads:backgroundTerminals:list', ['t1'])).toEqual([])
  })

  it('threads:backgroundTerminals:terminate forwards the process id and returns its result', async () => {
    const args = ['t1', 'proc7']
    const ipc = await viaIpc('threads:backgroundTerminals:terminate', args)
    expect(await viaControlRpc('threads:backgroundTerminals:terminate', args)).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.get(["t1"])',
      'session.terminateBackgroundTerminal(["proc7"])',
      'session.terminateBackgroundTerminal:settled',
    ])

    expect(await resultViaIpc('threads:backgroundTerminals:terminate', args)).toBe(true)
    expect(await resultViaControlRpc('threads:backgroundTerminals:terminate', args)).toBe(true)

    H.state.hasSession = false
    expect(await resultViaIpc('threads:backgroundTerminals:terminate', args)).toBe(false)
    expect(await resultViaControlRpc('threads:backgroundTerminals:terminate', args)).toBe(false)
  })

  it('threads:backgroundTerminals:clean awaits the session rather than floating its promise', async () => {
    const ipc = await viaIpc('threads:backgroundTerminals:clean', ['t1'])
    const rpc = await viaControlRpc('threads:backgroundTerminals:clean', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.get(["t1"])',
      'session.cleanBackgroundTerminals([])',
      'session.cleanBackgroundTerminals:settled',
    ])
  })
})

describe('threads:send — the one deliberate divergence', () => {
  const args = ['t1', 'hello', undefined]

  it('passes the ssh config and the wsl config to the right getOrCreate slots', async () => {
    // The default fixture nulls both, so the two slots render identically and a transposed
    // getSshConfigForThread/getWslConfigForThread survives every other assertion here.
    // Distinct values make the slots tell each other apart.
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
    }

    const ipc = await viaIpc('threads:send', args)
    const rpc = await viaControlRpc('threads:send', args)

    const entry = (log: string[]): string | undefined =>
      log.find((line) => line.startsWith('sessionManager.getOrCreate'))

    expect(entry(rpc)).toBe(entry(ipc))
    expect(entry(ipc)).toBe(
      'sessionManager.getOrCreate(["t1","C:/repo",' + JSON.stringify(window) +
      ',' + JSON.stringify(DISTINCT_SSH) + ',' + JSON.stringify(DISTINCT_WSL) + '])',
    )
  })

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

  it('the remote echo carries the exact payload the renderer merges on', async () => {
    const rpc = await viaControlRpc('threads:send', args)
    const echo = rpc.find((entry) => entry.startsWith('window.send'))

    // Pinned in full: the renderer's message-merge keys off `role` and `source`, and the
    // whole point of sending it on the window directly (rather than via emitAppEvent) is
    // that it must NOT go back out over SSE to the device that already rendered it.
    expect(echo).toBe(
      'window.send(["thread:output:t1",{"type":"text","content":"hello","metadata":{"role":"user","source":"remote_client"}}])',
    )
  })

  it('the echo lands after the message is handed to the session, not before', async () => {
    const rpc = await viaControlRpc('threads:send', args)
    const sent = rpc.findIndex((entry) => entry.startsWith('session.sendMessage'))
    const echoed = rpc.findIndex((entry) => entry.startsWith('window.send'))

    expect(sent).toBeGreaterThanOrEqual(0)
    expect(echoed).toBeGreaterThan(sent)
  })

  it('both forward SendOptions untouched', async () => {
    const options = { planMode: true, clientUserMessageId: 'c1' }
    const withOptions = ['t1', 'hello', options]
    const ipc = await viaIpc('threads:send', withOptions)
    const rpc = await viaControlRpc('threads:send', withOptions)

    const expected = `session.sendMessage(["hello",${JSON.stringify(options)}])`
    expect(ipc).toContain(expected)
    expect(rpc).toContain(expected)
  })

  it('both refuse when the local working directory is missing', async () => {
    H.state.pathExists = false

    await expect(viaIpc('threads:send', args)).rejects.toThrow('Directory not found: "C:/repo"')
    await expect(viaControlRpc('threads:send', args)).rejects.toThrow(
      'Directory not found: "C:/repo"',
    )
  })

  it('both capture the git branch on the way past', async () => {
    const ipc = await viaIpc('threads:send', args)
    const rpc = await viaControlRpc('threads:send', args)

    // Fire-and-forget, so only the kick-off is deterministic in the recorded log.
    expect(ipc).toContain('git.getCachedGitBranch(["C:/repo",null,null])')
    expect(rpc).toContain('git.getCachedGitBranch(["C:/repo",null,null])')
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
