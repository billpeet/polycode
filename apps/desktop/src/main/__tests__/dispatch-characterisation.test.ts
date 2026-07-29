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
    /**
     * Whether the thread already has messages. Steers two branches that no other
     * fixture field reaches: `threads:archive` (archive vs delete) and `threads:setWsl`
     * (locked after the first message).
     */
    threadHasMessages: false,
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

  /**
   * The `Forge` instance `createForge` resolves to — the same shape trick as `session`.
   *
   * Every method is `settlesLate` because every one of them is `async` on the real
   * interface: without that, `return (await createForge(...)).listPullRequests()` and a
   * version that dropped the returned promise would record the same log.
   */
  const forge = {
    listPullRequests: settlesLate('forge.listPullRequests', [{ id: 1, title: 'PR one' }]),
    getCurrentBranchPullRequest: settlesLate('forge.getCurrentBranchPullRequest', { id: 2 }),
    createPullRequest: settlesLate('forge.createPullRequest', { id: 3 }),
    checkoutPullRequest: settlesLate('forge.checkoutPullRequest', { branch: 'pr-3' }),
    getPullRequestsWebUrl: settlesLate('forge.getPullRequestsWebUrl', 'https://forge.test/prs'),
    getRepoWebUrl: settlesLate('forge.getRepoWebUrl', 'https://forge.test/repo'),
  }

  return { log, state, note, stub, autoModule, settlesLate, session, forge }
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
  threadHasMessages: H.stub('db.threadHasMessages', () => H.state.threadHasMessages),
  // Recorded, not a bare function: `threads:create` derives provider/model through it and
  // the derivation itself — that it happens, and before createThread — is the behaviour.
  getLastUsedProviderAndModel: H.stub('db.getLastUsedProviderAndModel', {
    provider: 'claude',
    model: 'opus',
  }),
  listLocations: H.stub('db.listLocations', () => (H.state.location ? [H.state.location] : [])),
  listThreads: H.stub('db.listThreads', [{ id: 't1', name: 'Thread one' }]),
  listArchivedThreads: H.stub('db.listArchivedThreads', [{ id: 't-old', name: 'Old thread' }]),
  archivedThreadCount: H.stub('db.archivedThreadCount', 7),
  createThread: H.stub('db.createThread', { id: 't-new', name: 'New thread' }),
  getThreadModifiedFiles: H.stub('db.getThreadModifiedFiles', ['src/a.ts']),
  archiveThread: H.stub('db.archiveThread', 'RET_archiveThread'),
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
  deleteThread: H.stub('db.deleteThread', 'RET_deleteThread'),
  unarchiveThread: H.stub('db.unarchiveThread', 'RET_unarchiveThread'),
  updateThreadName: H.stub('db.updateThreadName', 'RET_updateThreadName'),
  updateThreadModel: H.stub('db.updateThreadModel', 'RET_updateThreadModel'),
  updateThreadProviderAndModel: H.stub(
    'db.updateThreadProviderAndModel', 'RET_updateThreadProviderAndModel',
  ),
  updateThreadReasoningLevel: H.stub(
    'db.updateThreadReasoningLevel', 'RET_updateThreadReasoningLevel',
  ),
  updateThreadCodexPersonality: H.stub(
    'db.updateThreadCodexPersonality', 'RET_updateThreadCodexPersonality',
  ),
  updateThreadCodexReasoningSummary: H.stub(
    'db.updateThreadCodexReasoningSummary', 'RET_updateThreadCodexReasoningSummary',
  ),
  updateThreadCursorThinking: H.stub(
    'db.updateThreadCursorThinking', 'RET_updateThreadCursorThinking',
  ),
  updateThreadCursorContext: H.stub('db.updateThreadCursorContext', 'RET_updateThreadCursorContext'),
  updateThreadUnread: H.stub('db.updateThreadUnread', 'RET_updateThreadUnread'),
  updateThreadWsl: H.stub('db.updateThreadWsl', 'RET_updateThreadWsl'),
  updateThreadYoloMode: H.stub('db.updateThreadYoloMode', 'RET_updateThreadYoloMode'),
  updateThreadPermissionMode: H.stub(
    'db.updateThreadPermissionMode', 'RET_updateThreadPermissionMode',
  ),
  listCommands: H.stub('db.listCommands', () => [{ id: 'cmd1', name: 'dev' }]),
  createCommand: H.stub('db.createCommand', 'RET_createCommand'),
  updateCommand: H.stub('db.updateCommand', 'RET_updateCommand'),
  deleteCommand: H.stub('db.deleteCommand', 'RET_deleteCommand'),
  listLocationPools: H.stub('db.listLocationPools', [{ id: 'pool1', name: 'Pool one' }]),
  createLocationPool: H.stub('db.createLocationPool', { id: 'pool-new', name: 'Pool new' }),
  updateLocationPool: H.stub('db.updateLocationPool', 'RET_updateLocationPool'),
  deleteLocationPool: H.stub('db.deleteLocationPool', 'RET_deleteLocationPool'),
  // The token is part of the row on purpose — `youtrack:servers:list` deliberately serves
  // it to both transports, and a handler that stripped it would still look plausible.
  listYouTrackServers: H.stub('db.listYouTrackServers', [
    { id: 'yt1', name: 'YT', url: 'https://yt.test', token: 'secret-token' },
    // A second row so ORDER is observable: against a one-element fixture a handler that
    // reversed or re-sorted the list would pass, and row order is visible in the settings UI.
    { id: 'yt2', name: 'YT two', url: 'https://yt2.test', token: 'second-token' },
  ]),
  createYouTrackServer: H.stub('db.createYouTrackServer', { id: 'yt-new' }),
  updateYouTrackServer: H.stub('db.updateYouTrackServer', 'RET_updateYouTrackServer'),
  deleteYouTrackServer: H.stub('db.deleteYouTrackServer', 'RET_deleteYouTrackServer'),
  listSlashCommands: H.stub('db.listSlashCommands', [
    { id: 'sc1', project_id: null, name: 'review', description: null, prompt: 'Review it' },
  ]),
  createSlashCommand: H.stub('db.createSlashCommand', { id: 'sc-new' }),
  updateSlashCommand: H.stub('db.updateSlashCommand', 'RET_updateSlashCommand'),
  deleteSlashCommand: H.stub('db.deleteSlashCommand', 'RET_deleteSlashCommand'),
  getImportedSessionIds: H.stub('db.getImportedSessionIds', ['sess-a', 'sess-b']),
  importThread: H.stub('db.importThread', { id: 't-imported', name: 'Imported thread' }),
}))

vi.mock('../forge', () => ({ createForge: H.stub('forge.createForge', () => H.forge) }))

// The three file backends are mocked separately, with values that differ per backend, so
// "which implementation did the connection type select" is readable straight off the log.
vi.mock('../files', () => H.autoModule('files', {
  listDirectory: H.stub('files.listDirectory', [{ name: 'local.ts', isDirectory: false }]),
  readFileContent: H.stub('files.readFileContent', { content: 'local', truncated: false }),
  listAllFiles: H.stub('files.listAllFiles', [{ path: 'local.ts' }]),
}))

// settlesLate for the ssh trio only: those three are `async` on the real module, the local
// and WSL ones are synchronous. Mirroring that keeps the log honest about what is awaited.
vi.mock('../ssh', () => H.autoModule('ssh', {
  sshListDirectory: H.settlesLate('ssh.sshListDirectory', [{ name: 'remote.ts', isDirectory: false }]),
  sshReadFileContent: H.settlesLate('ssh.sshReadFileContent', { content: 'ssh', truncated: false }),
  sshListAllFiles: H.settlesLate('ssh.sshListAllFiles', [{ path: 'remote.ts' }]),
}))

vi.mock('../wsl', () => H.autoModule('wsl', {
  wslListDirectory: H.stub('wsl.wslListDirectory', [{ name: 'wsl.ts', isDirectory: false }]),
  wslReadFileContent: H.stub('wsl.wslReadFileContent', { content: 'wsl', truncated: false }),
  wslListAllFiles: H.stub('wsl.wslListAllFiles', [{ path: 'wsl.ts' }]),
}))

vi.mock('../file-watch', () => H.autoModule('fileWatch', {
  startFileWatch: H.stub('fileWatch.startFileWatch', true),
  // Sentinel for a `: void` callee — see "handlers pass the callee's result through".
  stopFileWatch: H.stub('fileWatch.stopFileWatch', 'RET_stopFileWatch'),
}))

vi.mock('../claude-history', () => H.autoModule('claudeHistory', {
  listClaudeProjects: H.stub('claudeHistory.listClaudeProjects', [{ encodedPath: 'C--repo' }]),
  listClaudeSessions: H.stub('claudeHistory.listClaudeSessions', [{ sessionId: 'sess-a' }]),
  parseSessionMessages: H.stub('claudeHistory.parseSessionMessages', [
    { role: 'user', content: 'hi', metadata: { tool: null }, timestamp: '2026-01-01T00:00:00.000Z' },
  ]),
}))

vi.mock('../youtrack', () => ({
  testYouTrackConnection: H.settlesLate('youtrack.testYouTrackConnection', { ok: true }),
  searchYouTrack: H.settlesLate('youtrack.searchYouTrack', [{ id: 'YT-1' }]),
}))

// One label for all five model modules: the channel under test already names the provider,
// and a single prefix keeps the per-channel table below readable.
vi.mock('../claude-models', () => H.autoModule('claudeModels', {
  listClaudeAvailableModels: H.settlesLate('models.listClaudeAvailableModels', [{ id: 'opus' }]),
}))
vi.mock('../codex-models', () => H.autoModule('codexModels', {
  listCodexAvailableModels: H.settlesLate('models.listCodexAvailableModels', [{ id: 'gpt-5' }]),
}))
vi.mock('../opencode-models', () => H.autoModule('opencodeModels', {
  listOpenCodeAvailableModels: H.settlesLate('models.listOpenCodeAvailableModels', [{ id: 'oc' }]),
}))
vi.mock('../pi-models', () => H.autoModule('piModels', {
  listPiAvailableModels: H.settlesLate('models.listPiAvailableModels', [{ id: 'pi' }]),
}))
vi.mock('../cursor-models', () => H.autoModule('cursorModels', {
  listCursorAvailableModels: H.settlesLate('models.listCursorAvailableModels', [{ id: 'cursor' }]),
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

// Mocked so `threads:getLogs` records a call and returns something distinguishable. The
// real module reads `%userData%/logs/<id>.log` and swallows every failure into `[]`, which
// would make "handler deleted" and "handler working" look identical here.
vi.mock('../thread-logger', () => H.autoModule('threadLogger', {
  getThreadLogs: H.stub('threadLogger.getThreadLogs', [{ type: 'start', at: '2026-01-01' }]),
}))

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
  H.state.threadHasMessages = false
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
    ['threads:delete', ['t1'], 'RET_deleteThread'],
    ['threads:unarchive', ['t1'], 'RET_unarchiveThread'],
    ['threads:updateName', ['t1', 'Renamed'], 'RET_updateThreadName'],
    ['threads:updateModel', ['t1', 'sonnet'], 'RET_updateThreadModel'],
    [
      'threads:updateProviderAndModel', ['t1', 'codex', 'gpt-5'],
      'RET_updateThreadProviderAndModel',
    ],
    ['threads:updateReasoningLevel', ['t1', 'high'], 'RET_updateThreadReasoningLevel'],
    ['threads:updateCodexPersonality', ['t1', 'concise'], 'RET_updateThreadCodexPersonality'],
    [
      'threads:updateCodexReasoningSummary', ['t1', 'detailed'],
      'RET_updateThreadCodexReasoningSummary',
    ],
    ['threads:updateCursorThinking', ['t1', true], 'RET_updateThreadCursorThinking'],
    ['threads:updateCursorContext', ['t1', 'ctx'], 'RET_updateThreadCursorContext'],
    ['threads:setUnread', ['t1', true], 'RET_updateThreadUnread'],
    ['threads:setYolo', ['t1', true], 'RET_updateThreadYoloMode'],
    ['threads:setPermissionMode', ['t1', 'acceptEdits'], 'RET_updateThreadPermissionMode'],
    ['location-pools:update', ['pool1', 'Renamed'], 'RET_updateLocationPool'],
    ['location-pools:delete', ['pool1'], 'RET_deleteLocationPool'],
    ['youtrack:servers:update', ['yt1', 'YT', 'https://yt.test', 'tok'], 'RET_updateYouTrackServer'],
    ['youtrack:servers:delete', ['yt1'], 'RET_deleteYouTrackServer'],
    ['slash-commands:update', ['sc1', 'review', null, 'p'], 'RET_updateSlashCommand'],
    ['slash-commands:delete', ['sc1'], 'RET_deleteSlashCommand'],
  ]

  for (const [channel, args, expected] of cases) {
    it(`${channel} returns its callee's value on both transports`, async () => {
      expect(await resultViaIpc(channel, args)).toBe(expected)
      expect(await resultViaControlRpc(channel, args)).toBe(expected)
    })
  }

  it('files:watchStop returns its callee\'s value — neither pre-fold path did', async () => {
    // The one channel in this batch where BOTH legacy paths discarded a `: void` callee:
    // ipc/handlers.ts called `stopFileWatch(filePath)` as a statement and control-rpc.ts
    // followed it with `return undefined`. Nothing observable turned on it — `stopFileWatch`
    // returns undefined and the contract's result is `void` — so the fold applies the
    // standing rule and returns it, removing the floated-promise trap if it ever goes async.
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'local',
      ssh: null, wsl: null,
    }
    expect(await resultViaIpc('files:watchStop', ['C:/repo/a.ts'])).toBe('RET_stopFileWatch')
    expect(await resultViaControlRpc('files:watchStop', ['C:/repo/a.ts'])).toBe('RET_stopFileWatch')
  })

  it('threads:setWsl returns its callee\'s value — the one place the two paths differed', async () => {
    // Recorded because it is the only form-level disagreement found in this fold: pre-fold,
    // control-rpc.ts wrote `return updateThreadWsl(...)` and ipc/handlers.ts called it as a
    // statement. Nothing observable turned on it — the callee is `: void` and so is the
    // contract's result — so the fold adopts the returning form, and this pins it.
    const args = ['t1', true, 'Ubuntu']
    expect(await resultViaIpc('threads:setWsl', args)).toBe('RET_updateThreadWsl')
    expect(await resultViaControlRpc('threads:setWsl', args)).toBe('RET_updateThreadWsl')
  })
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

describe('threads:* CRUD and settings — both transports agree', () => {
  it('threads:list', async () => {
    const ipc = await viaIpc('threads:list', ['p1'])
    const rpc = await viaControlRpc('threads:list', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.listThreads(["p1"])'])
    expect(await resultViaIpc('threads:list', ['p1'])).toEqual([{ id: 't1', name: 'Thread one' }])
    expect(await resultViaControlRpc('threads:list', ['p1'])).toEqual([
      { id: 't1', name: 'Thread one' },
    ])
  })

  it('threads:create derives provider/model from the project before inserting', async () => {
    const args = ['p1', 'New thread', 'loc1']
    const ipc = await viaIpc('threads:create', args)
    const rpc = await viaControlRpc('threads:create', args)

    expect(rpc).toEqual(ipc)
    // The derivation is the behaviour: createThread's own `provider = 'claude-code'` /
    // `model = 'claude-opus-4-8'` parameter defaults would otherwise silently take over,
    // so dropping the lookup would still produce a valid-looking thread.
    expect(ipc).toEqual([
      'db.getLastUsedProviderAndModel(["p1"])',
      'db.createThread(["p1","New thread","loc1","claude","opus"])',
    ])

    expect(await resultViaIpc('threads:create', args)).toEqual({ id: 't-new', name: 'New thread' })
    expect(await resultViaControlRpc('threads:create', args)).toEqual({
      id: 't-new', name: 'New thread',
    })
  })

  it('threads:archivedCount', async () => {
    const ipc = await viaIpc('threads:archivedCount', ['p1'])
    const rpc = await viaControlRpc('threads:archivedCount', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.archivedThreadCount(["p1"])'])
    expect(await resultViaIpc('threads:archivedCount', ['p1'])).toBe(7)
    expect(await resultViaControlRpc('threads:archivedCount', ['p1'])).toBe(7)
  })

  it('threads:listArchived forwards limit/offset raw — omitted and explicitly null alike', async () => {
    const paged = ['p1', 25, 50]
    expect(await viaControlRpc('threads:listArchived', paged)).toEqual(
      await viaIpc('threads:listArchived', paged),
    )
    expect(await viaIpc('threads:listArchived', paged)).toEqual([
      'db.listArchivedThreads(["p1",25,50])',
    ])

    // Neither path coalesces, and neither needs to. listArchivedThreads binds
    // `limit ?? -1, offset ?? 0` *in its own body*, which absorbs `undefined` and `null`
    // identically — the first of the three optional-argument shapes seen in this fold, not
    // the `commands:create` parameter-default shape that `null` sails past.
    expect(await viaIpc('threads:listArchived', ['p1'])).toEqual([
      'db.listArchivedThreads(["p1",undefined,undefined])',
    ])
    expect(await viaControlRpc('threads:listArchived', ['p1'])).toEqual([
      'db.listArchivedThreads(["p1",undefined,undefined])',
    ])
    expect(await viaIpc('threads:listArchived', ['p1', null, null])).toEqual([
      'db.listArchivedThreads(["p1",null,null])',
    ])
    expect(await viaControlRpc('threads:listArchived', ['p1', null, null])).toEqual([
      'db.listArchivedThreads(["p1",null,null])',
    ])

    expect(await resultViaIpc('threads:listArchived', ['p1'])).toEqual([
      { id: 't-old', name: 'Old thread' },
    ])
    expect(await resultViaControlRpc('threads:listArchived', ['p1'])).toEqual([
      { id: 't-old', name: 'Old thread' },
    ])
  })

  it('threads:unarchive', async () => {
    const ipc = await viaIpc('threads:unarchive', ['t1'])
    const rpc = await viaControlRpc('threads:unarchive', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.unarchiveThread(["t1"])'])
  })

  it('threads:getModifiedFiles resolves the working dir first', async () => {
    const ipc = await viaIpc('threads:getModifiedFiles', ['t1'])
    const rpc = await viaControlRpc('threads:getModifiedFiles', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'db.getLocationForThread(["t1"])',
      'db.getThreadModifiedFiles(["t1","C:/repo"])',
    ])
    expect(await resultViaIpc('threads:getModifiedFiles', ['t1'])).toEqual(['src/a.ts'])
    expect(await resultViaControlRpc('threads:getModifiedFiles', ['t1'])).toEqual(['src/a.ts'])
  })

  it('threads:getModifiedFiles passes an empty working dir when the thread has no location', async () => {
    H.state.location = null

    const ipc = await viaIpc('threads:getModifiedFiles', ['t1'])
    const rpc = await viaControlRpc('threads:getModifiedFiles', ['t1'])

    expect(rpc).toEqual(ipc)
    // `getWorkingDirForThread(...) ?? ''` — the coalesce is load-bearing: the callee's
    // parameter is `workingDir: string`, so a null would reach a `path` API as null.
    expect(ipc).toEqual([
      'db.getLocationForThread(["t1"])',
      'db.getThreadModifiedFiles(["t1",""])',
    ])
  })

  it('threads:getLogs', async () => {
    const ipc = await viaIpc('threads:getLogs', ['t1'])
    const rpc = await viaControlRpc('threads:getLogs', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['threadLogger.getThreadLogs(["t1"])'])
    expect(await resultViaIpc('threads:getLogs', ['t1'])).toEqual([
      { type: 'start', at: '2026-01-01' },
    ])
    expect(await resultViaControlRpc('threads:getLogs', ['t1'])).toEqual([
      { type: 'start', at: '2026-01-01' },
    ])
  })

  it('threads:updateCursorThinking/Context keep an explicit null intact', async () => {
    // `null` is a meaningful value on these two — "inherit the default" rather than
    // "argument absent" — so anything that coalesced it away would change what is written.
    expect(await viaIpc('threads:updateCursorThinking', ['t1', null])).toEqual([
      'sessionManager.remove(["t1"])', 'db.updateThreadCursorThinking(["t1",null])',
    ])
    expect(await viaControlRpc('threads:updateCursorThinking', ['t1', null])).toEqual([
      'sessionManager.remove(["t1"])', 'db.updateThreadCursorThinking(["t1",null])',
    ])
    // false must survive too — a `|| null` in place of a pass-through would eat it.
    expect(await viaIpc('threads:updateCursorThinking', ['t1', false])).toEqual([
      'sessionManager.remove(["t1"])', 'db.updateThreadCursorThinking(["t1",false])',
    ])
    expect(await viaIpc('threads:updateCursorContext', ['t1', null])).toEqual([
      'sessionManager.remove(["t1"])', 'db.updateThreadCursorContext(["t1",null])',
    ])
    expect(await viaControlRpc('threads:updateCursorContext', ['t1', null])).toEqual([
      'sessionManager.remove(["t1"])', 'db.updateThreadCursorContext(["t1",null])',
    ])
    // The empty string is the other value a truthiness-based rewrite would destroy.
    expect(await viaIpc('threads:updateCursorContext', ['t1', ''])).toEqual([
      'sessionManager.remove(["t1"])', 'db.updateThreadCursorContext(["t1",""])',
    ])
  })
})

/**
 * The convention no type enforces: drop the live session *before* the DB write, so the
 * next message is served by a session created from the changed row.
 *
 * Asserting the whole sequence with `toEqual` rather than two `toContain`s is the point —
 * a handler that writes first and removes after would satisfy "both happened".
 */
describe('threads:* — sessionManager.remove runs before the write', () => {
  const cases: Array<[channel: string, args: unknown[], write: string]> = [
    ['threads:delete', ['t1'], 'db.deleteThread(["t1"])'],
    ['threads:updateModel', ['t1', 'sonnet'], 'db.updateThreadModel(["t1","sonnet"])'],
    [
      'threads:updateProviderAndModel', ['t1', 'codex', 'gpt-5'],
      'db.updateThreadProviderAndModel(["t1","codex","gpt-5"])',
    ],
    [
      'threads:updateReasoningLevel', ['t1', 'high'],
      'db.updateThreadReasoningLevel(["t1","high"])',
    ],
    [
      'threads:updateCodexPersonality', ['t1', 'concise'],
      'db.updateThreadCodexPersonality(["t1","concise"])',
    ],
    [
      'threads:updateCodexReasoningSummary', ['t1', 'detailed'],
      'db.updateThreadCodexReasoningSummary(["t1","detailed"])',
    ],
    [
      'threads:updateCursorThinking', ['t1', true],
      'db.updateThreadCursorThinking(["t1",true])',
    ],
    [
      'threads:updateCursorContext', ['t1', 'extra context'],
      'db.updateThreadCursorContext(["t1","extra context"])',
    ],
    ['threads:setYolo', ['t1', true], 'db.updateThreadYoloMode(["t1",true])'],
    [
      'threads:setPermissionMode', ['t1', 'acceptEdits'],
      'db.updateThreadPermissionMode(["t1","acceptEdits"])',
    ],
  ]

  for (const [channel, args, write] of cases) {
    it(`${channel} removes the session, then writes`, async () => {
      const expected = ['sessionManager.remove(["t1"])', write]
      const ipc = await viaIpc(channel, args)
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual(expected)
    })
  }

  it('threads:setUnread deliberately does NOT drop the session', async () => {
    // The odd one out among the setters: marking a thread read/unread cannot change how
    // the CLI is spawned, so the session survives. Pinned so the fold does not "helpfully"
    // make it uniform with its neighbours.
    const args = ['t1', true]
    const ipc = await viaIpc('threads:setUnread', args)
    const rpc = await viaControlRpc('threads:setUnread', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.updateThreadUnread(["t1",true])'])
  })

  it('threads:setWsl checks the message lock first, then removes, then writes', async () => {
    const args = ['t1', true, 'Ubuntu']
    const ipc = await viaIpc('threads:setWsl', args)
    const rpc = await viaControlRpc('threads:setWsl', args)

    expect(rpc).toEqual(ipc)
    // Note the ordering differs from its neighbours: the guard runs before the remove, so
    // a locked thread does not lose its session as a side effect of a refused write.
    expect(ipc).toEqual([
      'db.threadHasMessages(["t1"])',
      'sessionManager.remove(["t1"])',
      'db.updateThreadWsl(["t1",true,"Ubuntu"])',
    ])
  })

  it('threads:setWsl is locked once the thread has messages', async () => {
    H.state.threadHasMessages = true

    const ipc = await viaIpc('threads:setWsl', ['t1', true, 'Ubuntu'])
    const rpc = await viaControlRpc('threads:setWsl', ['t1', true, 'Ubuntu'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.threadHasMessages(["t1"])'])
    expect(await resultViaIpc('threads:setWsl', ['t1', true, 'Ubuntu'])).toBeUndefined()
    expect(await resultViaControlRpc('threads:setWsl', ['t1', true, 'Ubuntu'])).toBeUndefined()
  })

  it('threads:setWsl writes a null distro verbatim, in argument order', async () => {
    // Turning WSL off carries a null distro, and it must be written rather than coalesced:
    // updateThreadWsl binds it straight into the column. The two booleans/strings also pin
    // the (threadId, useWsl, wslDistro) order, which nothing else in this file does.
    const ipc = await viaIpc('threads:setWsl', ['t1', false, null])
    const rpc = await viaControlRpc('threads:setWsl', ['t1', false, null])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'db.threadHasMessages(["t1"])',
      'sessionManager.remove(["t1"])',
      'db.updateThreadWsl(["t1",false,null])',
    ])
  })

  it('threads:archive removes the session, then archives a thread that has messages', async () => {
    H.state.threadHasMessages = true

    const ipc = await viaIpc('threads:archive', ['t1'])
    const rpc = await viaControlRpc('threads:archive', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.remove(["t1"])',
      'db.threadHasMessages(["t1"])',
      'db.archiveThread(["t1"])',
    ])
    expect(await resultViaIpc('threads:archive', ['t1'])).toBe('archived')
    expect(await resultViaControlRpc('threads:archive', ['t1'])).toBe('archived')
  })

  it('threads:archive deletes an empty thread outright instead of archiving it', async () => {
    // The other branch: an untouched thread is not worth keeping, so archive means delete.
    // Both the call made and the discriminated result differ, and both are pinned — the
    // literal is what the renderer branches on to decide which toast to show.
    const ipc = await viaIpc('threads:archive', ['t1'])
    const rpc = await viaControlRpc('threads:archive', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'sessionManager.remove(["t1"])',
      'db.threadHasMessages(["t1"])',
      'db.deleteThread(["t1"])',
    ])
    expect(await resultViaIpc('threads:archive', ['t1'])).toBe('deleted')
    expect(await resultViaControlRpc('threads:archive', ['t1'])).toBe('deleted')

    // Neither branch returns the callee's value — the literal is the contract's result
    // type, so `archiveThread`/`deleteThread`'s sentinel must NOT leak through.
    expect(await resultViaIpc('threads:archive', ['t1'])).not.toBe('RET_deleteThread')
  })
})

describe('location-pools:* — both transports agree', () => {
  const cases: Array<[channel: string, args: unknown[], expected: string]> = [
    ['location-pools:list', ['p1'], 'db.listLocationPools(["p1"])'],
    ['location-pools:create', ['p1', 'Pool one'], 'db.createLocationPool(["p1","Pool one"])'],
    ['location-pools:update', ['pool1', 'Renamed'], 'db.updateLocationPool(["pool1","Renamed"])'],
    ['location-pools:delete', ['pool1'], 'db.deleteLocationPool(["pool1"])'],
  ]

  for (const [channel, args, expected] of cases) {
    it(channel, async () => {
      const ipc = await viaIpc(channel, args)
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([expected])
    })
  }

  it('location-pools:list returns the rows untouched', async () => {
    const rows = [{ id: 'pool1', name: 'Pool one' }]
    expect(await resultViaIpc('location-pools:list', ['p1'])).toEqual(rows)
    expect(await resultViaControlRpc('location-pools:list', ['p1'])).toEqual(rows)
  })
})

describe('forge:* — both transports agree', () => {
  /**
   * Every forge channel resolves the repo's host config first and hands it to
   * `createForge`. Distinct ssh/wsl values, because `createForge(repoPath, ssh, wsl)`
   * takes the two adjacent and the default fixture nulls both — a transposition would
   * otherwise be invisible.
   */
  const hosted = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
    }
  }
  const createEntry =
    `forge.createForge(["C:/repo",${JSON.stringify(DISTINCT_SSH)},${JSON.stringify(DISTINCT_WSL)}])`

  const cases: Array<[channel: string, args: unknown[], call: string]> = [
    ['forge:pr:list', ['C:/repo'], 'forge.listPullRequests([])'],
    ['forge:pr:current', ['C:/repo', 'feature/x'], 'forge.getCurrentBranchPullRequest(["feature/x"])'],
    [
      'forge:pr:create',
      ['C:/repo', { target: 'main', title: 'T', description: 'D' }],
      'forge.createPullRequest([{"target":"main","title":"T","description":"D"}])',
    ],
    ['forge:pr:webUrl', ['C:/repo'], 'forge.getPullRequestsWebUrl([])'],
    ['forge:repo:webUrl', ['C:/repo'], 'forge.getRepoWebUrl([])'],
  ]

  for (const [channel, args, call] of cases) {
    it(`${channel} builds the forge from the repo's host config, then awaits it`, async () => {
      hosted()
      const ipc = await viaIpc(channel, args)
      hosted()
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      // The `:settled` entry is the point: these five return the forge call's promise
      // rather than floating it.
      expect(ipc).toEqual([
        'db.getLocationByPath(["C:/repo"])',
        createEntry,
        call,
        `${call.slice(0, call.indexOf('('))}:settled`,
      ])
    })
  }

  it('forge:pr:create leaves an omitted description omitted on the wire', async () => {
    // With only the fully-populated payload in the table above, a handler materialising
    // `description: payload.description ?? ''` would pass — an observable wire change for
    // every caller that omits the field.
    hosted()
    const ipc = await viaIpc('forge:pr:create', ['C:/repo', { target: 'main', title: 'T' }])
    hosted()
    const rpc = await viaControlRpc('forge:pr:create', ['C:/repo', { target: 'main', title: 'T' }])

    expect(rpc).toEqual(ipc)
    expect(ipc).toContain('forge.createPullRequest([{"target":"main","title":"T"}])')
  })

  it('forge:pr:checkout invalidates the git cache AFTER the checkout settles', async () => {
    hosted()
    const ipc = await viaIpc('forge:pr:checkout', ['C:/repo', 42])
    hosted()
    const rpc = await viaControlRpc('forge:pr:checkout', ['C:/repo', 42])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'db.getLocationByPath(["C:/repo"])',
      createEntry,
      'forge.checkoutPullRequest([42])',
      'forge.checkoutPullRequest:settled',
      // invalidateRepoGitCache re-resolves the config, then clears the cache.
      'db.getLocationByPath(["C:/repo"])',
      `git.invalidateGitCache(["C:/repo",${JSON.stringify(DISTINCT_SSH)},${JSON.stringify(DISTINCT_WSL)}])`,
    ])
  })

  it('the forge channels return the forge\'s answer', async () => {
    expect(await resultViaIpc('forge:pr:list', ['C:/repo'])).toEqual([{ id: 1, title: 'PR one' }])
    expect(await resultViaControlRpc('forge:pr:list', ['C:/repo'])).toEqual([
      { id: 1, title: 'PR one' },
    ])
    expect(await resultViaIpc('forge:pr:checkout', ['C:/repo', 42])).toEqual({ branch: 'pr-3' })
    expect(await resultViaControlRpc('forge:pr:checkout', ['C:/repo', 42])).toEqual({
      branch: 'pr-3',
    })
    expect(await resultViaIpc('forge:repo:webUrl', ['C:/repo'])).toBe('https://forge.test/repo')
    expect(await resultViaControlRpc('forge:repo:webUrl', ['C:/repo'])).toBe(
      'https://forge.test/repo',
    )
  })
})

/**
 * `files:*` is the one family in this batch that *branches on the connection type*, so the
 * risk is not argument order but implementation selection: local, ssh and wsl each have
 * their own backend and picking the wrong one still returns a plausible-looking answer.
 *
 * All three branches are covered for all three read channels, and the ssh case installs a
 * WSL config too — `if (ssh) … if (wsl) …` means ssh must win, which no single-config
 * fixture can prove.
 */
describe('files:* — both transports select the same backend', () => {
  const local = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'local',
      ssh: null, wsl: null,
    }
  }
  const sshAndWsl = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
    }
  }
  const wslOnly = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'wsl',
      ssh: null, wsl: DISTINCT_WSL,
    }
  }
  /**
   * The ordinary ssh location — ssh set, wsl null.
   *
   * Load-bearing on its own: with only `sshAndWsl` in the file, every ssh assertion is
   * also satisfied by `if (ssh && wsl)`, and a real ssh location would fall through to the
   * *local* backend and read the Windows filesystem for a remote path. That is exactly the
   * "wrong backend, plausible answer" failure these branches are pinned to prevent.
   */
  const sshOnly = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: null,
    }
  }

  const cases: Array<[channel: string, target: string, local: string, ssh: string, wsl: string]> = [
    ['files:list', 'C:/repo', 'files.listDirectory', 'ssh.sshListDirectory', 'wsl.wslListDirectory'],
    [
      'files:read', 'C:/repo/a.ts',
      'files.readFileContent', 'ssh.sshReadFileContent', 'wsl.wslReadFileContent',
    ],
    ['files:searchList', 'C:/repo', 'files.listAllFiles', 'ssh.sshListAllFiles', 'wsl.wslListAllFiles'],
  ]

  for (const [channel, target, localFn, sshFn, wslFn] of cases) {
    it(`${channel} uses the local backend for a local location`, async () => {
      local()
      const ipc = await viaIpc(channel, [target])
      local()
      const rpc = await viaControlRpc(channel, [target])

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        `db.getLocationByPath(["${target}"])`,
        `${localFn}(["${target}"])`,
      ])
    })

    it(`${channel} prefers the ssh backend when both configs are present`, async () => {
      sshAndWsl()
      const ipc = await viaIpc(channel, [target])
      sshAndWsl()
      const rpc = await viaControlRpc(channel, [target])

      expect(rpc).toEqual(ipc)
      // (config, path) argument order is pinned by the rendered call, and the `:settled`
      // entry proves the async ssh backend's promise is returned rather than floated.
      expect(ipc).toEqual([
        `db.getLocationByPath(["${target}"])`,
        `${sshFn}([${JSON.stringify(DISTINCT_SSH)},"${target}"])`,
        `${sshFn}:settled`,
      ])
    })

    it(`${channel} uses the ssh backend when only an ssh config is present`, async () => {
      sshOnly()
      const ipc = await viaIpc(channel, [target])
      sshOnly()
      const rpc = await viaControlRpc(channel, [target])

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        `db.getLocationByPath(["${target}"])`,
        `${sshFn}([${JSON.stringify(DISTINCT_SSH)},"${target}"])`,
        `${sshFn}:settled`,
      ])
    })

    it(`${channel} uses the wsl backend when only a wsl config is present`, async () => {
      wslOnly()
      const ipc = await viaIpc(channel, [target])
      wslOnly()
      const rpc = await viaControlRpc(channel, [target])

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        `db.getLocationByPath(["${target}"])`,
        `${wslFn}([${JSON.stringify(DISTINCT_WSL)},"${target}"])`,
      ])
    })
  }

  it('files:read returns whichever backend answered', async () => {
    local()
    expect(await resultViaIpc('files:read', ['C:/repo/a.ts'])).toEqual({
      content: 'local', truncated: false,
    })
    sshAndWsl()
    expect(await resultViaControlRpc('files:read', ['C:/repo/a.ts'])).toEqual({
      content: 'ssh', truncated: false,
    })
    wslOnly()
    expect(await resultViaIpc('files:read', ['C:/repo/a.ts'])).toEqual({
      content: 'wsl', truncated: false,
    })
  })

  it('files:watchStart watches only local paths, and hands the window to the watcher', async () => {
    local()
    const ipc = await viaIpc('files:watchStart', ['C:/repo/a.ts'])
    local()
    const rpc = await viaControlRpc('files:watchStart', ['C:/repo/a.ts'])

    expect(rpc).toEqual(ipc)
    // The window is the first argument — the closure on the IPC side, the parameter on the
    // control-RPC side. Both must resolve to the same BrowserWindow.
    expect(ipc).toEqual([
      'db.getLocationByPath(["C:/repo/a.ts"])',
      `fileWatch.startFileWatch([${JSON.stringify(window)},"C:/repo/a.ts"])`,
    ])
    local()
    expect(await resultViaIpc('files:watchStart', ['C:/repo/a.ts'])).toBe(true)
    local()
    expect(await resultViaControlRpc('files:watchStart', ['C:/repo/a.ts'])).toBe(true)
  })

  it('files:watchStart refuses an ssh- or wsl-hosted path without starting a watcher', async () => {
    for (const install of [sshOnly, wslOnly, sshAndWsl]) {
      install()
      const ipc = await viaIpc('files:watchStart', ['C:/repo/a.ts'])
      install()
      const rpc = await viaControlRpc('files:watchStart', ['C:/repo/a.ts'])

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual(['db.getLocationByPath(["C:/repo/a.ts"])'])

      install()
      expect(await resultViaIpc('files:watchStart', ['C:/repo/a.ts'])).toBe(false)
      install()
      expect(await resultViaControlRpc('files:watchStart', ['C:/repo/a.ts'])).toBe(false)
    }
  })

  it('files:watchStop stops the watcher unconditionally — no connection-type branch', async () => {
    sshAndWsl()
    const ipc = await viaIpc('files:watchStop', ['C:/repo/a.ts'])
    sshAndWsl()
    const rpc = await viaControlRpc('files:watchStop', ['C:/repo/a.ts'])

    expect(rpc).toEqual(ipc)
    // Note the absence of a getLocationByPath call: unlike watchStart, this one never
    // resolves the host config.
    expect(ipc).toEqual(['fileWatch.stopFileWatch(["C:/repo/a.ts"])'])
  })
})

describe('claude-history:* — both transports agree', () => {
  it('claude-history:listProjects and listSessions', async () => {
    expect(await viaControlRpc('claude-history:listProjects', [])).toEqual(
      await viaIpc('claude-history:listProjects', []),
    )
    expect(await viaIpc('claude-history:listProjects', [])).toEqual([
      'claudeHistory.listClaudeProjects([])',
    ])

    expect(await viaControlRpc('claude-history:listSessions', ['C--repo'])).toEqual(
      await viaIpc('claude-history:listSessions', ['C--repo']),
    )
    expect(await viaIpc('claude-history:listSessions', ['C--repo'])).toEqual([
      'claudeHistory.listClaudeSessions(["C--repo"])',
    ])
  })

  it('claude-history:importedIds', async () => {
    const ipc = await viaIpc('claude-history:importedIds', ['p1'])
    const rpc = await viaControlRpc('claude-history:importedIds', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.getImportedSessionIds(["p1"])'])
    expect(await resultViaIpc('claude-history:importedIds', ['p1'])).toEqual(['sess-a', 'sess-b'])
    expect(await resultViaControlRpc('claude-history:importedIds', ['p1'])).toEqual([
      'sess-a', 'sess-b',
    ])
  })

  it('claude-history:import reshapes the parsed messages and reorders the arguments', async () => {
    // The channel takes (projectId, locationId, sessionFilePath, sessionId, name) but
    // importThread takes (projectId, locationId, name, claudeSessionId, messages) — slots
    // 3 and 5 swap. Every value is distinct so a mis-ordering cannot hide.
    const args = ['p1', 'loc1', 'C:/sessions/sess-a.jsonl', 'sess-a', 'Imported thread']
    const ipc = await viaIpc('claude-history:import', args)
    const rpc = await viaControlRpc('claude-history:import', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'claudeHistory.parseSessionMessages(["C:/sessions/sess-a.jsonl"])',
      // `timestamp` is renamed to `created_at`; role/content/metadata pass through.
      'db.importThread(["p1","loc1","Imported thread","sess-a",' +
        '[{"role":"user","content":"hi","metadata":{"tool":null},' +
        '"created_at":"2026-01-01T00:00:00.000Z"}]])',
    ])
    expect(await resultViaIpc('claude-history:import', args)).toEqual({
      id: 't-imported', name: 'Imported thread',
    })
    expect(await resultViaControlRpc('claude-history:import', args)).toEqual({
      id: 't-imported', name: 'Imported thread',
    })
  })
})

describe('youtrack:* — both transports agree', () => {
  it('youtrack:servers:list serves the stored token to both transports', async () => {
    const ipc = await viaIpc('youtrack:servers:list', [])
    const rpc = await viaControlRpc('youtrack:servers:list', [])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.listYouTrackServers([])'])
    // Deliberate: the settings and mention UIs need the token to edit a server and to issue
    // authenticated searches, so neither path redacts it. Pinned so a later "sanitise the
    // remote response" instinct has to be an explicit decision.
    const expected = [
      { id: 'yt1', name: 'YT', url: 'https://yt.test', token: 'secret-token' },
      { id: 'yt2', name: 'YT two', url: 'https://yt2.test', token: 'second-token' },
    ]
    expect(await resultViaIpc('youtrack:servers:list', [])).toEqual(expected)
    expect(await resultViaControlRpc('youtrack:servers:list', [])).toEqual(expected)
  })

  const cases: Array<[channel: string, args: unknown[], expected: string[]]> = [
    [
      'youtrack:servers:create', ['YT', 'https://yt.test', 'tok'],
      ['db.createYouTrackServer(["YT","https://yt.test","tok"])'],
    ],
    [
      'youtrack:servers:update', ['yt1', 'YT', 'https://yt.test', 'tok'],
      ['db.updateYouTrackServer(["yt1","YT","https://yt.test","tok"])'],
    ],
    ['youtrack:servers:delete', ['yt1'], ['db.deleteYouTrackServer(["yt1"])']],
    [
      'youtrack:test', ['https://yt.test', 'tok'],
      [
        'youtrack.testYouTrackConnection(["https://yt.test","tok"])',
        'youtrack.testYouTrackConnection:settled',
      ],
    ],
    [
      'youtrack:search', ['https://yt.test', 'tok', 'project: PC'],
      [
        'youtrack.searchYouTrack(["https://yt.test","tok","project: PC"])',
        'youtrack.searchYouTrack:settled',
      ],
    ],
  ]

  for (const [channel, args, expected] of cases) {
    it(channel, async () => {
      const ipc = await viaIpc(channel, args)
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual(expected)
    })
  }
})

describe('slash-commands:* — both transports agree', () => {
  it('slash-commands:list tags every row as a command', async () => {
    const ipc = await viaIpc('slash-commands:list', ['p1'])
    const rpc = await viaControlRpc('slash-commands:list', ['p1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.listSlashCommands(["p1"])'])

    // The `kind: 'command'` tag is the whole transform, and the renderer branches on it to
    // tell stored commands apart from detected skills on the same list.
    const expected = [{
      id: 'sc1', project_id: null, name: 'review', description: null, prompt: 'Review it',
      kind: 'command',
    }]
    expect(await resultViaIpc('slash-commands:list', ['p1'])).toEqual(expected)
    expect(await resultViaControlRpc('slash-commands:list', ['p1'])).toEqual(expected)
  })

  it('slash-commands:list passes an omitted or null projectId straight through', async () => {
    // `listSlashCommands` branches on `if (projectId)` — plain truthiness — so `undefined`,
    // `null` and `''` are already equivalent downstream and neither path coalesces.
    expect(await viaIpc('slash-commands:list', [])).toEqual(['db.listSlashCommands([undefined])'])
    expect(await viaControlRpc('slash-commands:list', [])).toEqual([
      'db.listSlashCommands([undefined])',
    ])
    expect(await viaIpc('slash-commands:list', [null])).toEqual(['db.listSlashCommands([null])'])
    expect(await viaControlRpc('slash-commands:list', [null])).toEqual([
      'db.listSlashCommands([null])',
    ])
  })

  const cases: Array<[channel: string, args: unknown[], expected: string]> = [
    [
      'slash-commands:create', [null, 'review', 'Review the diff', 'Do it'],
      'db.createSlashCommand([null,"review","Review the diff","Do it"])',
    ],
    [
      'slash-commands:create', ['p1', 'review', null, 'Do it'],
      'db.createSlashCommand(["p1","review",null,"Do it"])',
    ],
    [
      'slash-commands:update', ['sc1', 'review', 'Review the diff', 'Do it'],
      'db.updateSlashCommand(["sc1","review","Review the diff","Do it"])',
    ],
    ['slash-commands:delete', ['sc1'], 'db.deleteSlashCommand(["sc1"])'],
  ]

  for (const [channel, args, expected] of cases) {
    it(`${channel} forwards ${JSON.stringify(args)}`, async () => {
      const ipc = await viaIpc(channel, args)
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([expected])
    })
  }
})

/**
 * `models:*` is where a transposition would be hardest to see: the five channels each build
 * one `{cwd, ssh, wsl}` options object from the thread, so ssh and wsl travel *together*
 * rather than one-per-branch, and the default fixture nulls both.
 */
describe('models:* — both transports agree', () => {
  const cases: Array<[channel: string, fn: string, result: unknown]> = [
    ['models:claudeAvailable', 'models.listClaudeAvailableModels', [{ id: 'opus' }]],
    ['models:codexAvailable', 'models.listCodexAvailableModels', [{ id: 'gpt-5' }]],
    ['models:opencodeAvailable', 'models.listOpenCodeAvailableModels', [{ id: 'oc' }]],
    ['models:piAvailable', 'models.listPiAvailableModels', [{ id: 'pi' }]],
    ['models:cursorAvailable', 'models.listCursorAvailableModels', [{ id: 'cursor' }]],
  ]

  const hosted = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
    }
  }

  for (const [channel, fn, result] of cases) {
    it(`${channel} builds cwd/ssh/wsl from the thread, in that order`, async () => {
      hosted()
      const ipc = await viaIpc(channel, ['t1'])
      hosted()
      const rpc = await viaControlRpc(channel, ['t1'])

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        'db.threadExists(["t1"])',
        // getEffectiveWorkingDir — truthy, so getWorkingDirForThread is never reached
        'db.getLocationForThread(["t1"])',
        // getSshConfigForThread
        'db.getLocationForThread(["t1"])',
        // getWslConfigForThread
        'db.getLocationForThread(["t1"])',
        `${fn}([{"cwd":"C:/repo","ssh":${JSON.stringify(DISTINCT_SSH)},` +
          `"wsl":${JSON.stringify(DISTINCT_WSL)}}])`,
        `${fn}:settled`,
      ])

      hosted()
      expect(await resultViaIpc(channel, ['t1'])).toEqual(result)
      hosted()
      expect(await resultViaControlRpc(channel, ['t1'])).toEqual(result)
    })

    it(`${channel} falls through to getWorkingDirForThread on an empty effective cwd`, async () => {
      // The `||` (not `??`) in `getEffectiveWorkingDir(id) || getWorkingDirForThread(id)`.
      // A thread whose location row has gone away has an effective cwd of `''`, which is
      // not nullish — under `??` the second lookup would never run and `cwd` would be `''`.
      H.state.location = null

      const ipc = await viaIpc(channel, ['t1'])
      const rpc = await viaControlRpc(channel, ['t1'])

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        'db.threadExists(["t1"])',
        'db.getLocationForThread(["t1"])', // getEffectiveWorkingDir → ''
        'db.getLocationForThread(["t1"])', // getWorkingDirForThread → null (the || fired)
        'db.getLocationForThread(["t1"])', // getSshConfigForThread
        'db.getLocationForThread(["t1"])', // getWslConfigForThread
        `${fn}([{"cwd":null,"ssh":null,"wsl":null}])`,
        `${fn}:settled`,
      ])
    })

    it(`${channel} skips the thread lookup entirely for a missing thread`, async () => {
      H.state.threadExists = false

      const ipc = await viaIpc(channel, ['t1'])
      const rpc = await viaControlRpc(channel, ['t1'])

      // THE ONE PRE-FOLD DIVERGENCE IN THIS BATCH, and it was spelling rather than
      // behaviour. ipc/handlers.ts wrote `return listXAvailableModels()` — zero arguments
      // — while control-rpc.ts built `options` as `… : undefined` and always wrote
      // `listXAvailableModels(options)`. The recorder showed `[]` against `[undefined]`.
      //
      // Nothing downstream could tell them apart: the callee declares
      // `options: {…} = {}`, a *parameter* default, which fires on a missing argument and
      // on an explicitly-`undefined` one alike. (Contrast `commands:create`, where a
      // parameter default made an explicit `null` behave differently from `undefined` —
      // there is no `null` in play here, because the falsy test is on the way *in*.)
      //
      // The fold adopts the explicit-`undefined` form, so the two now agree exactly; this
      // pins that, and the `[undefined]` slot is what records which form won.
      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        'db.threadExists(["t1"])',
        `${fn}([undefined])`,
        `${fn}:settled`,
      ])
    })
  }

  it('an omitted or null threadId short-circuits before threadExists', async () => {
    // `!threadId || !threadExists(threadId)` on one side and `threadId && threadExists(...)`
    // on the other were the same truthiness test, so `undefined`, `null` and `''` all skip
    // the existence check without reaching the DB.
    for (const threadId of [[], [null], ['']] as unknown[][]) {
      const ipc = await viaIpc('models:claudeAvailable', threadId)
      const rpc = await viaControlRpc('models:claudeAvailable', threadId)

      expect(rpc).toEqual(ipc)
      expect(ipc).toEqual([
        'models.listClaudeAvailableModels([undefined])',
        'models.listClaudeAvailableModels:settled',
      ])
    }
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
