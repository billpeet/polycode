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
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CHANNEL_REGISTRY, LOCAL_CHANNELS, isLocalChannel, isRemoteChannel } from '@polycode/shared'
import type { RemoteHostInput, RemoteServerConfig } from '../../shared/types'

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
    /**
     * What `attachments.getFileInfo` answers. `null` is the "no such file" branch and a
     * size over 15 MB is the refusal branch of `attachments:readDataUrl`.
     */
    fileInfo: { size: 1234, mimeType: 'image/png' } as Record<string, unknown> | null,
    /**
     * Bytes the mocked `fs.readFileSync` serves. `null` delegates to the real one, so
     * anything in the graph that is not under test keeps working.
     */
    fileBytes: null as Buffer | null,
    /**
     * What `killByPid`/`killByPort` reject with, or `null` to resolve. `process:kill`
     * converts a rejection into `{ ok: false, error }` rather than throwing.
     */
    killError: null as string | null,
    /**
     * What the remote-control client's `invokeIfActive` answers, or `null` for "no active
     * host" — the state every other test in this file runs in, because it is the one that
     * exercises the local implementation.
     */
    remoteProxy: null as { handled: boolean; value?: unknown } | null,
    /**
     * What the client double's `getActiveHost` answers when no proxy is configured.
     *
     * Separate from `remoteProxy` because `remote:getActiveHost` is a *channel* that reads
     * it, not the forwarding hop: steering it through `remoteProxy` would mean that
     * channel's return value could only be characterised while a host was also being
     * proxied to, which is not the state it is normally called in.
     */
    activeHost: null as Record<string, unknown> | null,
    /** How many times the stubbed readFileSync served `fileBytes`. */
    fileReads: 0,
    /** How many times the adapter asked the remote client for the active host. */
    proxyChecks: 0,
    /** How many times the adapter took the remote-forwarding hop. */
    proxyInvokes: 0,
    /** Makes the mocked git read reject, so error propagation is observable. */
    gitShouldFail: false,
    /**
     * Paths `git.discardFileChanges` rejects for.
     *
     * `git:discardFiles` discards one file at a time and collects per-file errors so that
     * one failure does not abort the rest, then throws a summary. A whole-module failure
     * switch (`gitShouldFail`) cannot express that: the interesting case is *some* files
     * failing.
     */
    discardFailures: [] as string[],
    /**
     * Makes the mocked `publishRepositoryBranch` reject. Separate from `gitShouldFail`
     * because it is a different module — and because `git:publishBranch` is the one mutating
     * channel that still invalidates at the handler level, in a `finally`, so what it does on
     * failure differs from every sibling.
     */
    publishShouldFail: false,
    /**
     * What the `window` test double reports from `isMaximized()`. The only fixture that
     * steers `window:maximize`, whose whole body is
     * `isMaximized() ? unmaximize() : maximize()`.
     */
    isMaximized: false,
    /**
     * What `dialog.showOpenDialog` resolves to. `canceled: true` is the branch both
     * `dialog:*` channels normalise away — to `null` and to `[]` respectively, which are
     * different shapes and so cannot share an implementation.
     */
    dialogResult: { canceled: false, filePaths: ['C:/picked'] } as {
      canceled: boolean
      filePaths: string[]
    },
    /**
     * Whether the stubbed `runExecFile` rejects. `commandExists` is a try/catch around it,
     * so this is the only way to reach `shell:openInVsCode`'s openExternal fallback.
     */
    execFileFails: false,
    /**
     * The third argument `git:watchStart` hands `startRepoGitWatch` — the invalidation
     * callback the watcher fires on every repo change.
     *
     * Captured as a value rather than logged because the recorder renders a function as an
     * empty slot (`JSON.stringify(fn)` is `undefined`), so the call log alone cannot tell
     * `invalidateRepoGitCache` from any other function, nor from the `undefined` a *call*
     * would leave in that slot.
     */
    repoWatchCallback: null as unknown,
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
   * A `git.ts` *mutation* — the callees behind the 24 mutating `git:*` channels.
   *
   * Two properties beyond a plain stub, and both are load-bearing for this batch:
   *
   * - It settles on a macrotask (`settlesLate`), so "awaited" is observable. 18 of those 24
   *   handlers have a `void` contract result, so a handler that floated the promise would
   *   return the same value and log the same call. Since the invalidation moved down into
   *   `git.ts` — where this stub replaces it — the `:settled` entry is the *only* remaining
   *   evidence that the handler awaited at all.
   * - It rejects when `gitShouldFail`, so error propagation through each handler is
   *   answerable. (Whether a failed mutation invalidates is now a `git.ts` question, and is
   *   answered in `git-cache-invalidation.test.ts` against the real module.)
   */
  const gitMutation = (label: string, value: unknown = undefined) =>
    stub(label, () => new Promise((resolve, reject) => {
      setTimeout(() => {
        note(`${label}:settled`)
        if (state.gitShouldFail) reject(new Error('git exploded'))
        else resolve(value)
      }, 0)
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
    // Sentinel for a `: void` callee — see "handlers pass the callee's result through".
    switchSession: stub('session.switchSession', 'RET_switchSession'),
    getAssociatedPlan: stub('session.getAssociatedPlan', {
      name: 'plan.md', path: 'C:/repo/plan.md', content: '# Plan',
    }),
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

  /**
   * A stored remote host, as `RemoteControlClient` hands them out.
   *
   * One shared fixture so the seven client-instance `remote:*` channels can each return a
   * *distinguishable* value derived from it — a double whose methods all answered the same
   * object would let two handlers be transposed and still pass.
   */
  const REMOTE_HOST = {
    id: 'h1',
    label: 'Studio',
    baseUrl: 'http://192.168.1.10:3285',
    token: 'host-token',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  /**
   * The `RemoteControlClient` instance the seven client-instance `remote:*` handlers reach
   * through `ctx.remoteClient` — the same shape trick as `session` and `forge`.
   *
   * All seven handlers are pure delegation, so what there is to pin is the argument list,
   * the pass-through of the result, and that nothing else happens on the way. Hence exact
   * log equality plus a distinct return value per method.
   *
   * `getActiveHost` is deliberately NOT here. The ipcMain adapter's forwarding hop calls it
   * too, so it lives in the mock factory below where it is *counted* rather than logged — a
   * log entry would land in every pinned dual-path sequence in this file.
   */
  const remoteClient = {
    getHosts: stub('remoteClient.getHosts', [REMOTE_HOST]),
    addHost: stub('remoteClient.addHost', { ...REMOTE_HOST, id: 'added' }),
    updateHost: stub('remoteClient.updateHost', { ...REMOTE_HOST, id: 'updated' }),
    // No value: the contract's result is `void` and the real method returns nothing, so
    // "resolves undefined" is the thing to pin.
    removeHost: stub('remoteClient.removeHost'),
    setActiveHost: stub('remoteClient.setActiveHost', { ...REMOTE_HOST, id: 'activated' }),
    // settlesLate, not stub: `testHost` is the one async method of the seven, and with a
    // plain stub a handler that dropped the returned promise would log the same sequence.
    testHost: settlesLate('remoteClient.testHost', { ok: true }),
  }

  return {
    log, state, note, stub, autoModule, settlesLate, gitMutation, renderArgs, session, forge,
    remoteClient, REMOTE_HOST,
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: () => H.state.pathExists,
    // `attachments:readDataUrl` and the `attachments:saveFromPath` source read are the only
    // things under test that reach this. `fileBytes` defaults to null, so every other
    // reader in the module graph keeps the real implementation.
    readFileSync: (...args: unknown[]): unknown => {
      if (H.state.fileBytes === null) {
        return (actual.readFileSync as (...rest: unknown[]) => unknown)(...args)
      }
      H.state.fileReads += 1
      return H.state.fileBytes
    },
  }
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
  // Two rows so ORDER is observable — the session switcher lists them chronologically.
  listSessions: H.stub('db.listSessions', [
    { id: 's1', thread_id: 't1', name: 'Session one', is_active: true },
    { id: 's2', thread_id: 't1', name: 'Session two', is_active: false },
  ]),
  getActiveSession: H.stub('db.getActiveSession', {
    id: 's1', thread_id: 't1', name: 'Session one', is_active: true,
  }),
  // Distinct fixtures per query: `messages:list` and `messages:listBySession` take
  // different keys, and a handler that called the wrong one would still return messages.
  listMessages: H.stub('db.listMessages', [{ id: 'm1', role: 'user', content: 'by thread' }]),
  listMessagesBySession: H.stub('db.listMessagesBySession', [
    { id: 'm2', role: 'assistant', content: 'by session' },
  ]),
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
  // The repo watcher behind `git:watchStart`. It captures its `onChanged` argument so the
  // callback's *identity* is assertable — see `H.state.repoWatchCallback`.
  startRepoGitWatch: H.stub('fileWatch.startRepoGitWatch', (...args: unknown[]) => {
    H.state.repoWatchCallback = args[2]
    return true
  }),
  // Sentinel for a `: void` callee — see "handlers pass the callee's result through".
  stopRepoGitWatch: H.stub('fileWatch.stopRepoGitWatch', 'RET_stopRepoGitWatch'),
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
  getCachedGitStatus: H.stub('git.getCachedGitStatus', () => {
    // `gitShouldFail` lets a test prove a rejection propagates. Without it, wrapping a
    // handler body in try/catch and returning null passes the whole suite — and for
    // git:status that would show "not a repo" instead of surfacing a real failure.
    if (H.state.gitShouldFail) throw new Error('git exploded')
    return H.state.gitStatus
  }),
  getCachedGitBranch: H.stub('git.getCachedGitBranch', () => Promise.resolve('feature/x')),
  // ── The non-invalidating `git:*` batch ──────────────────────────────────────
  //
  // A distinct value per function, not a shared sentinel: the four `compare*` channels are
  // one transposition away from each other (`compareToMain` vs `compareDiffToMain`,
  // `ToBranch` vs `DiffToBranch`) and so are `commitFiles`/`commitDiff`. With a shared
  // value a mis-wired handler would still return something plausible, so the result
  // assertions carry as much of the pinning as the recorded calls do.
  getCachedLastCommit: H.stub('git.getCachedLastCommit', { hash: 'abc123', subject: 'Last commit' }),
  listStashes: H.stub('git.listStashes', [{ ref: 'stash@{0}', message: 'WIP' }]),
  getFileDiff: H.stub('git.getFileDiff', 'DIFF working tree'),
  getCachedCompareToMainChanges: H.stub('git.getCachedCompareToMainChanges', {
    baseRef: 'origin/main', files: [{ status: 'M', path: 'src/a.ts' }],
  }),
  getCompareToMainFileDiff: H.stub('git.getCompareToMainFileDiff', 'DIFF one file vs main'),
  getCompareToBranchChanges: H.stub('git.getCompareToBranchChanges', {
    baseRef: 'origin/release/1', files: [{ status: 'A', path: 'src/b.ts' }],
  }),
  getCompareToBranchDiff: H.stub('git.getCompareToBranchDiff', 'DIFF all files vs branch'),
  listCommits: H.stub('git.listCommits', [{ hash: 'c1', subject: 'One' }]),
  listCommitFiles: H.stub('git.listCommitFiles', [{ status: 'M', path: 'src/c.ts' }]),
  getCommitFileDiff: H.stub('git.getCommitFileDiff', 'DIFF one file of one commit'),
  listCachedBranches: H.stub('git.listCachedBranches', {
    current: 'feature/x', local: ['feature/x', 'main'], remote: ['origin/main'],
  }),
  isGitRepoCached: H.stub('git.isGitRepoCached', true),
  getRemoteUrl: H.stub('git.getRemoteUrl', 'https://example.test/r.git'),
  detectGitHostingProviderCached: H.stub('git.detectGitHostingProviderCached', 'github'),
  getCachedDefaultBranch: H.stub('git.getCachedDefaultBranch', 'main'),
  findMergedBranches: H.stub('git.findMergedBranches', ['feature/done']),
  deleteBranches: H.stub('git.deleteBranches', { deleted: ['feature/done'], failed: [] }),
  forceUnlockRepo: H.stub('git.forceUnlockRepo', { removed: ['index.lock'] }),
  generateCommitMessage: H.stub('git.generateCommitMessage', 'feat: from the diff'),
  generateCommitMessageWithContext: H.stub(
    'git.generateCommitMessageWithContext', 'feat: from the conversation',
  ),
  generateBranchName: H.stub('git.generateBranchName', 'feature/generated'),
  generatePullRequestText: H.stub('git.generatePullRequestText', {
    title: 'PR title', description: 'PR body',
  }),
  // settlesLate, alone in this batch: `git:fetchRemote`'s contract result is `void`, so
  // post-fold the handler cannot return what this resolves to and the `:settled` entry is
  // the only observable proof that it is awaited rather than floated.
  gitFetchRemoteCached: H.settlesLate('git.gitFetchRemoteCached', { fetched: true }),

  // ── The 24 invalidating `git:*` channels ────────────────────────────────────
  //
  // All `gitMutation`: they settle late (so the invalidation's position *after* the awaited
  // operation is pinned) and they reject under `gitShouldFail` (so what the invalidation
  // does on failure is observable). Values mirror what git.ts actually resolves — note that
  // three of them resolve an object the channel contract declares `void`.
  commitChanges: H.gitMutation('git.commitChanges'),
  amendCommit: H.gitMutation('git.amendCommit'),
  undoLastCommit: H.gitMutation('git.undoLastCommit'),
  stageFile: H.gitMutation('git.stageFile'),
  unstageFile: H.gitMutation('git.unstageFile'),
  stageAll: H.gitMutation('git.stageAll'),
  unstageAll: H.gitMutation('git.unstageAll'),
  stageFiles: H.gitMutation('git.stageFiles'),
  discardAllChanges: H.gitMutation('git.discardAllChanges'),
  // Per-path failure rather than the module-wide switch: `git:discardFiles` loops and
  // collects per-file errors, so "one of three failed" is the shape worth driving.
  discardFileChanges: H.stub('git.discardFileChanges', (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const filePath = args[1] as string
      setTimeout(() => {
        H.note(`git.discardFileChanges:settled(${JSON.stringify(filePath)})`)
        if (H.state.discardFailures.includes(filePath)) {
          reject(new Error(`cannot discard ${filePath}`))
        } else if (H.state.gitShouldFail) {
          reject(new Error('git exploded'))
        } else resolve(undefined)
      }, 0)
    })),
  // `{ pushed: true }` / `{ pulled: true }` against a `void` contract — see the deliberate
  // value change these three take in the fold.
  gitPush: H.gitMutation('git.gitPush', { pushed: true }),
  gitPushSetUpstream: H.gitMutation('git.gitPushSetUpstream', { pushed: true }),
  gitPullOrigin: H.gitMutation('git.gitPullOrigin', { pulled: true }),
  // The two pull callees. `gitPull` resolves `{ pulled: true }` — no `stashed` field, so it
  // does not actually satisfy the contract's PullResult; `gitPullWithAutoStash` does.
  gitPull: H.gitMutation('git.gitPull', { pulled: true }),
  gitPullWithAutoStash: H.gitMutation('git.gitPullWithAutoStash', {
    pulled: true, stashed: true, stashRef: 'stash@{0}',
  }),
  createStash: H.gitMutation('git.createStash'),
  applyStash: H.gitMutation('git.applyStash'),
  popStash: H.gitMutation('git.popStash'),
  dropStash: H.gitMutation('git.dropStash'),
  checkoutBranch: H.gitMutation('git.checkoutBranch'),
  createBranch: H.gitMutation('git.createBranch'),
  mergeBranch: H.gitMutation('git.mergeBranch', { conflicts: ['src/a.ts'] }),
  gitInit: H.gitMutation('git.gitInit'),
}))

// `git:publishBranch`'s callee. Mocked because the real adapter drives publish-branch.ts
// through half of git.ts and the forge, and because the *shape* under test here is the
// handler's `try/finally` — the one place in this batch where the invalidation runs on
// failure too. Settles late so "awaited, then invalidated" is observable.
vi.mock('../publish-branch-adapter', () => H.autoModule('publishBranch', {
  publishRepositoryBranch: H.stub('publishBranch.publishRepositoryBranch', () =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        H.note('publishBranch.publishRepositoryBranch:settled')
        if (H.state.publishShouldFail) reject(new Error('publish exploded'))
        else resolve({ ok: true, branch: 'feature/x', pullRequest: { id: 7 } })
      }, 0)
    })),
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
// Sentinels on the four `: void` methods, so "forwarded and returned" is distinguishable
// from "forwarded and discarded"; a distinctive buffer so `getBuffer` cannot be faked.
vi.mock('../terminal/manager', () => ({
  ptyManager: H.autoModule('ptyManager', {
    spawn: H.stub('ptyManager.spawn', 'RET_ptySpawn'),
    write: H.stub('ptyManager.write', 'RET_ptyWrite'),
    resize: H.stub('ptyManager.resize', 'RET_ptyResize'),
    kill: H.stub('ptyManager.kill', 'RET_ptyKill'),
    getBuffer: H.stub('ptyManager.getBuffer', 'buffered terminal output'),
  }),
}))

vi.mock('../attachments', () => H.autoModule('attachments', {
  getAttachmentDir: H.stub('attachments.getAttachmentDir', 'C:/tmp/polycode-attachments'),
  saveAttachment: H.stub('attachments.saveAttachment', { tempPath: 'C:/tmp/att/saved.png', id: 'att-saved' }),
  copyAttachmentFromPath: H.stub('attachments.copyAttachmentFromPath', {
    tempPath: 'C:/tmp/att/copied.png', id: 'att-copied',
  }),
  // Sentinel for a `: void` callee — see "handlers pass the callee's result through".
  cleanupThreadAttachments: H.stub('attachments.cleanupThreadAttachments', 'RET_cleanupThreadAttachments'),
  getFileInfo: H.stub('attachments.getFileInfo', () => H.state.fileInfo),
}))

vi.mock('../health/checker', () => H.autoModule('cli', {
  checkCliHealth: H.settlesLate('cli.checkCliHealth', { installed: true, currentVersion: '1.2.3' }),
  updateCli: H.settlesLate('cli.updateCli', { success: true, output: 'updated' }),
  invalidateCliHealthCache: H.stub('cli.invalidateCliHealthCache'),
}))

vi.mock('../skills', () => H.autoModule('skills', {
  // Two rows so the derived `sort_order` is observable, and one of each scope so the
  // `scope === 'project' ? 'project' : null` mapping cannot be faked by a constant.
  listDetectedSkills: H.stub('skills.listDetectedSkills', [
    {
      id: 'sk1', name: 'review', description: 'Review the diff', invocation: '/review',
      scope: 'project', harness: 'claude-code', path: 'C:/repo/.claude/skills/review',
    },
    {
      id: 'sk2', name: 'deploy', description: null, invocation: '/deploy',
      scope: 'global', harness: 'claude-code', path: 'C:/home/.claude/skills/deploy',
    },
  ]),
}))

vi.mock('../host-connection-tests', () => H.autoModule('hostTests', {
  // Distinct answers per backend, so "which connection test ran" is readable off the result.
  testSshConnection: H.settlesLate('hostTests.testSshConnection', { ok: true }),
  testWslConnection: H.settlesLate('hostTests.testWslConnection', { ok: false, error: 'no distro' }),
  listWslDistros: H.settlesLate('hostTests.listWslDistros', ['Ubuntu', 'Debian']),
}))

vi.mock('../process-control', () => H.autoModule('processControl', {
  // The probe behind `commandExists`, which is a try/catch: resolving means "on PATH".
  runExecFile: H.stub('processControl.runExecFile', () =>
    H.state.execFileFails ? Promise.reject(new Error('not found')) : Promise.resolve()),
  // Hand-rolled rather than `settlesLate` because `process:kill`'s whole shape is its
  // rejection branch: it converts a thrown error into `{ ok: false, error }`.
  killByPid: H.stub('processControl.killByPid', () => new Promise((resolve, reject) => {
    setTimeout(() => {
      H.note('processControl.killByPid:settled')
      if (H.state.killError) reject(new Error(H.state.killError))
      else resolve(undefined)
    }, 0)
  })),
  killByPort: H.stub('processControl.killByPort', () => new Promise((resolve, reject) => {
    setTimeout(() => {
      H.note('processControl.killByPort:settled')
      if (H.state.killError) reject(new Error(H.state.killError))
      else resolve(undefined)
    }, 0)
  })),
}))

// Mocked so `threads:getLogs` records a call and returns something distinguishable. The
// real module reads `%userData%/logs/<id>.log` and swallows every failure into `[]`, which
// would make "handler deleted" and "handler working" look identical here.
vi.mock('../thread-logger', () => H.autoModule('threadLogger', {
  getThreadLogs: H.stub('threadLogger.getThreadLogs', [{ type: 'start', at: '2026-01-01' }]),
}))

vi.mock('../updater', () => H.autoModule('updater', {
  // Sentinel on a `: void` callee, so "called and discarded" stays distinguishable from
  // "called and returned" — `update:check` must return getUpdateState()'s value, not this.
  checkForUpdates: H.stub('updater.checkForUpdates', 'RET_checkForUpdates'),
  applyUpdate: H.stub('updater.applyUpdate', true),
  getUpdateState: H.stub('updater.getUpdateState', { status: 'downloaded', version: '1.2.3' }),
}))

vi.mock('../webhook/server', () => H.autoModule('webhook', {
  // Sentinel for a `: void` callee — see "handlers pass the callee's result through".
  restartWebhookServer: H.stub('webhook.restartWebhookServer', 'RET_restartWebhookServer'),
}))

vi.mock('../app-logger', () => H.autoModule('appLogger', {
  getLogsDirPath: H.stub('appLogger.getLogsDirPath', 'C:/tmp/polycode-logs'),
}))

// The three `remote:*` channels that reach module-level config functions rather than the
// RemoteControlClient instance: `remote:getServerConfig`, `remote:setServerConfig` and
// `remote:regenerateServerToken`.
vi.mock('../remote/config', () => H.autoModule('remoteConfig', {
  readRemoteServerConfig: H.stub('remoteConfig.readRemoteServerConfig', {
    enabled: false, host: '127.0.0.1', port: 3285, token: 'server-token',
  }),
  // Echoes its argument with a marked token, which is what makes the two writing channels
  // characterisable at all: both hand the *saved* config to the server restart and return
  // it, and an implementation that passed the incoming config along instead would be
  // indistinguishable from a stub that echoed verbatim. It also makes the result
  // deterministic despite `remote:regenerateServerToken` minting a random token.
  saveRemoteServerConfig: H.stub(
    'remoteConfig.saveRemoteServerConfig',
    (config: unknown) => ({ ...(config as Record<string, unknown>), token: 'normalised-token' }),
  ),
}))

// Mocked for the first time by the fold of `remote:setServerConfig` and
// `remote:regenerateServerToken`: pre-fold this module was reached only from
// `remote/client.ts`, which this file replaces wholesale, so it was never loaded. Post-fold
// `ipc/handlers.ts` imports the restart as a value to pre-bind it to the window, and the
// real module opens an HTTP listener.
vi.mock('../remote/server', () => H.autoModule('remoteServer', {
  restartRemoteControlServer: H.stub('remoteServer.restartRemoteControlServer'),
}))

vi.mock('../remote/lan', () => H.autoModule('remoteLan', {
  getPairingInfo: H.stub('remoteLan.getPairingInfo', {
    addresses: ['192.168.1.10'], hostname: 'desktop-test',
  }),
}))

// `shell:openInVsCode` and `shell:openInTerminal` are *entirely* defined by the process
// they launch — argv, detachment and the candidate order. `unref()` is recorded too: a
// spawned terminal that is never unref'd keeps the Electron process alive.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: H.stub('proc.spawn', () => ({ unref: H.stub('proc.unref') })),
  }
})

// The remote-forwarding hop belongs to the ipcMain adapter only. Inactive by default, so
// the local implementation runs — which is exactly the path we want to compare.
//
// `H.state.remoteProxy` switches it on for the one channel where the hop is not a plain
// same-channel forward: `attachments:saveFromPath` reads the file *here* and uploads it to
// the host under a different channel (`attachments:save`), so the hop is behaviour rather
// than plumbing and has its own test below.
//
// The double is also what `ctx.remoteClient` is for the seven folded client-instance
// `remote:*` channels — `H.remoteClient` holds their recorders.
vi.mock('../remote/client', () => ({
  registerRemoteControlIpcHandlers: () => ({
    ...H.remoteClient,
    // `invokeIfActive` returns handled:true exactly when both of these hold, so the
    // adapter hoists them to decide whether the source file is worth encoding at all.
    getActiveHost: () => {
      // Counted, not logged: logging would add an entry to every pinned IPC sequence in
      // the file. The count is what the local-only-channels test below asserts.
      H.state.proxyChecks += 1
      return H.state.remoteProxy ? { id: 'host1' } : H.state.activeHost
    },
    // Channel-aware on purpose. A double that ignores its argument lets the adapter ask
    // about the WRONG channel and still pass — and `attachments:saveFromPath` asking about
    // itself (remote:false) instead of `attachments:save` would silently write every
    // attachment to the local machine while controlling a remote desktop.
    shouldProxy: (channel: string) => isRemoteChannel(channel),
    invokeIfActive: async (channel: string, args: unknown[]) => {
      // Counted, not logged: logging would add an entry to every pinned IPC sequence.
      H.state.proxyInvokes += 1
      if (!H.state.remoteProxy) return { handled: false, value: undefined }
      H.note(`remoteClient.invokeIfActive(["${channel}",${H.renderArgs(args)}])`)
      return H.state.remoteProxy
    },
  }),
}))

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
/** `ipcMain.on` registrations — a few channels are fire-and-forget rather than invoke. */
const ipcListeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      // Real Electron throws on a second handler for the same channel. A plain Map.set
      // would silently keep the last one and hide a double registration.
      if (ipcHandlers.has(channel)) {
        throw new Error(`duplicate ipcMain.handle registration for ${channel}`)
      }
      ipcHandlers.set(channel, listener)
    },
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcListeners.set(channel, listener)
    },
  },
  // `dialog`, `shell` and `clipboard` were bare `{}` until the shell:*, dialog:*, app:* and
  // window:* families were folded — nothing under test reached them. They are recording
  // stubs now because for those channels the Electron call *is* the behaviour: most return
  // nothing, so an implementation that called `openPath` where it should have called
  // `showItemInFolder` would satisfy every assertion about its return value.
  app: {
    getPath: () => 'C:/tmp',
    getVersion: H.stub('app.getVersion', '0.0.0'),
    isPackaged: false,
  },
  dialog: {
    showOpenDialog: H.stub('dialog.showOpenDialog', () => H.state.dialogResult),
  },
  shell: {
    openPath: H.stub('shell.openPath', 'RET_openPath'),
    showItemInFolder: H.stub('shell.showItemInFolder', 'RET_showItemInFolder'),
    openExternal: H.stub('shell.openExternal', 'RET_openExternal'),
  },
  clipboard: {
    writeText: H.stub('clipboard.writeText', 'RET_writeText'),
  },
  BrowserWindow: class {},
}))

/** `window.on(...)` registrations — the titlebar push listeners, not channels. */
const windowListeners = new Map<string, () => void>()

const window = {
  // Recorded into a separate map rather than the call log, so the titlebar push listeners
  // are assertable without polluting every pinned sequence. Unrecorded, deleting either
  // `window.on('maximize'|'unmaximize', …)` passed the whole suite.
  on: (event: string, listener: () => void) => { windowListeners.set(event, listener) },
  minimize: H.stub('window.minimize'),
  maximize: H.stub('window.maximize'),
  unmaximize: H.stub('window.unmaximize'),
  close: H.stub('window.close'),
  isMaximized: H.stub('window.isMaximized', () => H.state.isMaximized),
  webContents: {
    isDestroyed: () => false,
    send: H.stub('window.send'),
  },
} as unknown as import('electron').BrowserWindow

const { registerIpcHandlers } = await import('../ipc/handlers')
const { MIGRATED_CHANNELS } = await import('../ipc/channel-handlers')
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
  H.state.fileInfo = { size: 1234, mimeType: 'image/png' }
  H.state.fileBytes = null
  H.state.killError = null
  H.state.remoteProxy = null
  H.state.activeHost = null
  H.state.fileReads = 0
  H.state.proxyChecks = 0
  H.state.proxyInvokes = 0
  H.state.gitShouldFail = false
  H.state.discardFailures = []
  H.state.publishShouldFail = false
  H.state.isMaximized = false
  H.state.dialogResult = { canceled: false, filePaths: ['C:/picked'] }
  H.state.execFileFails = false
  H.state.repoWatchCallback = null
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
  it('git:commit — including the main-branch policy check', async () => {
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
      // The commit is awaited. `commitChanges` settles on a macrotask (`H.gitMutation`), so this
      // entry appears only if the handler awaited it — and since the cache invalidation moved
      // into `git.ts` (which this file mocks), it is the only remaining evidence of that.
      'git.commitChanges:settled',
      // Two lookups, not three: the third used to be `invalidateRepoGitCache` re-deriving
      // ssh/wsl to invalidate the cache. `commitChanges` does that itself now, with the configs
      // it was handed. Asserted in `git-cache-invalidation.test.ts`.
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

  it('git:watchStop returns its callee\'s value — neither pre-fold path did', async () => {
    // Same shape as `files:watchStop`: both legacy paths called the `: void`
    // `stopRepoGitWatch` as a statement (control-rpc.ts then wrote `return undefined`).
    // Nothing observable turns on it, so the fold applies the standing rule and returns it.
    expect(await resultViaIpc('git:watchStop', ['C:/repo'])).toBe('RET_stopRepoGitWatch')
    expect(await resultViaControlRpc('git:watchStop', ['C:/repo'])).toBe('RET_stopRepoGitWatch')
  })

  it('the pty and session channels return their callee\'s value — no pre-fold path did', async () => {
    // Four more of the `files:watchStop` shape: both legacy paths called a `: void` callee
    // as a statement (control-rpc.ts then wrote `return undefined`). Nothing observable
    // turns on it today, so the fold applies the standing rule and returns it, which
    // removes the floated-promise trap if any of them ever goes async — `ptyManager.write`
    // in particular sits in front of a child process.
    const cases: Array<[channel: string, args: unknown[], expected: string]> = [
      ['sessions:switch', ['t1', 's2'], 'RET_switchSession'],
      ['terminal:write', ['term-1', 'ls\r'], 'RET_ptyWrite'],
      ['terminal:resize', ['term-1', 100, 30], 'RET_ptyResize'],
      ['terminal:kill', ['term-1'], 'RET_ptyKill'],
    ]
    for (const [channel, args, expected] of cases) {
      expect(await resultViaIpc(channel, args)).toBe(expected)
      expect(await resultViaControlRpc(channel, args)).toBe(expected)
    }
  })

  it('attachments:cleanup returns its callee\'s value — the one place the two paths differed', async () => {
    // The only form-level disagreement found in this fold, and the same shape as
    // `threads:setWsl` in the last one: ipc/handlers.ts wrote
    // `return cleanupThreadAttachments(threadId)` and control-rpc.ts called it as a
    // statement followed by `return undefined`. Nothing observable turned on it — the
    // callee is `: void` and so is the contract's result — so the fold adopts the
    // returning form, and this pins it.
    expect(await resultViaIpc('attachments:cleanup', ['t1'])).toBe('RET_cleanupThreadAttachments')
    expect(await resultViaControlRpc('attachments:cleanup', ['t1'])).toBe(
      'RET_cleanupThreadAttachments',
    )
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

/**
 * The 27 `git:*` read channels.
 *
 * This used to be "the channels that do not invalidate the git cache", against a second batch
 * of 24 that did. No `git:*` handler invalidates any more: every `git.ts` mutation clears its
 * own cache scope at the end of its own body (git.ts:119-146), so the invalidation is invisible
 * to this file — `../git` is mocked wholesale here. That property is asserted directly against
 * the real module in `git-cache-invalidation.test.ts`.
 *
 * Nearly every channel here resolves `{ ssh, wsl } = getConfigForPath(repoPath)` and hands
 * both to a `git.ts` function in adjacent trailing slots. The default fixture nulls both,
 * which makes a transposition invisible, so this whole block runs against DISTINCT_SSH and
 * DISTINCT_WSL.
 */
/**
 * Two properties the exact-log assertions are blind to on their own.
 *
 * Every git handler resolves `{ ssh, wsl } = getConfigForPath(repoPath)` and forwards both.
 * The tests below install DISTINCT_SSH/DISTINCT_WSL so a transposition fails — but with a
 * config always present, nothing pins what arrives when there is NO location row, and
 * nothing pins that a failing git read propagates rather than being swallowed. Both
 * mutations survived the whole suite before these tests existed.
 */
describe('git:* — host config nullability and error propagation', () => {
  const CHANNELS: Array<[channel: string, args: unknown[], callee: string]> = [
    ['git:status', ['C:/repo'], 'git.getCachedGitStatus'],
    ['git:branch', ['C:/repo'], 'git.getCachedGitBranch'],
    ['git:branches', ['C:/repo'], 'git.listCachedBranches'],
    ['git:isRepo', ['C:/repo'], 'git.isGitRepoCached'],
  ]

  it('a path with no location row forwards null, not undefined', async () => {
    // getConfigForPath coalesces a missing row to `{ ssh: null, wsl: null }`, and the git
    // functions accept `null`. This is the common case — any path not in repo_locations —
    // and it was entirely uncharacterised: `ssh ?? undefined` passed everything.
    H.state.location = null

    for (const [channel, args, callee] of CHANNELS) {
      const ipc = await viaIpc(channel, args)
      H.state.location = null
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      expect(ipc, channel).toEqual([
        'db.getLocationByPath(["C:/repo"])',
        `${callee}(["C:/repo",null,null])`,
      ])
      H.state.location = null
    }
  })

  it('a path with no location row forwards null to the mutating channels too', async () => {
    // The same gap on the mutating half of the family. This used to have a second
    // `getLocationByPath` after the operation, because `invalidateRepoGitCache` re-resolved the
    // config to recover ssh/wsl — the exact cost the move into `git.ts` removes, since these
    // functions already have both as parameters. One lookup now, and it is the only one.
    for (const [channel, args, call] of [
      ['git:stage', ['C:/repo', 'src/a.ts'], 'git.stageFile(["C:/repo","src/a.ts",null,null])'],
      ['git:init', ['C:/repo'], 'git.gitInit(["C:/repo",null,null])'],
    ] as Array<[string, unknown[], string]>) {
      H.state.location = null
      const ipc = await viaIpc(channel, args)
      H.state.location = null
      const rpc = await viaControlRpc(channel, args)

      expect(rpc, channel).toEqual(ipc)
      expect(ipc, channel).toEqual([
        'db.getLocationByPath(["C:/repo"])',
        call,
        `${call.slice(0, call.indexOf('('))}:settled`,
      ])
      // The invalidation is the callee's business now, and `../git` is mocked here — so its
      // absence from this log is expected rather than a regression. Where it IS asserted:
      // `git-cache-invalidation.test.ts`, against the real `git.ts`.
      expect(ipc.some((entry) => entry.includes('invalidateGitCache')), channel).toBe(false)
    }
    H.state.location = null
  })

  it('a failing git read rejects on both transports rather than resolving null', async () => {
    // Swallowing this would make git:status report "not a repo" for a genuine failure.
    H.state.gitShouldFail = true
    await expect(viaIpc('git:status', ['C:/repo'])).rejects.toThrow('git exploded')
    H.state.gitShouldFail = true
    await expect(viaControlRpc('git:status', ['C:/repo'])).rejects.toThrow('git exploded')
  })
})

describe('git:* — the reads, and the three mutations that sit among them', () => {
  beforeEach(() => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
    }
  })

  /** The `(…, ssh, wsl)` tail every call below ends in. */
  const hosts = `${JSON.stringify(DISTINCT_SSH)},${JSON.stringify(DISTINCT_WSL)}`
  const lookup = 'db.getLocationByPath(["C:/repo"])'

  /**
   * One row per channel: the arguments in, the single `git.ts` call out, and the value that
   * comes back. Every callee is distinct, which is what pins the `compare*` quartet and the
   * `commitFiles`/`commitDiff` pair against being wired to each other.
   */
  const cases: Array<[channel: string, args: unknown[], call: string, result: unknown]> = [
    ['git:branch', ['C:/repo'], `git.getCachedGitBranch(["C:/repo",${hosts}])`, 'feature/x'],
    ['git:status', ['C:/repo'], `git.getCachedGitStatus(["C:/repo",${hosts}])`, { branch: 'feature/x' }],
    [
      'git:lastCommit', ['C:/repo'], `git.getCachedLastCommit(["C:/repo",${hosts}])`,
      { hash: 'abc123', subject: 'Last commit' },
    ],
    [
      'git:stashList', ['C:/repo'], `git.listStashes(["C:/repo",${hosts}])`,
      [{ ref: 'stash@{0}', message: 'WIP' }],
    ],
    [
      'git:diff', ['C:/repo', 'src/a.ts', true],
      `git.getFileDiff(["C:/repo","src/a.ts",true,${hosts}])`, 'DIFF working tree',
    ],
    [
      'git:compareToMain', ['C:/repo'], `git.getCachedCompareToMainChanges(["C:/repo",${hosts}])`,
      { baseRef: 'origin/main', files: [{ status: 'M', path: 'src/a.ts' }] },
    ],
    [
      'git:compareDiffToMain', ['C:/repo', 'src/a.ts'],
      `git.getCompareToMainFileDiff(["C:/repo","src/a.ts",${hosts}])`, 'DIFF one file vs main',
    ],
    [
      'git:compareToBranch', ['C:/repo', 'release/1'],
      `git.getCompareToBranchChanges(["C:/repo","release/1",${hosts}])`,
      { baseRef: 'origin/release/1', files: [{ status: 'A', path: 'src/b.ts' }] },
    ],
    [
      'git:compareDiffToBranch', ['C:/repo', 'release/1'],
      `git.getCompareToBranchDiff(["C:/repo","release/1",${hosts}])`, 'DIFF all files vs branch',
    ],
    [
      'git:log', ['C:/repo', { range: 'origin/main..HEAD', limit: 20 }],
      `git.listCommits(["C:/repo",{"range":"origin/main..HEAD","limit":20},${hosts}])`,
      [{ hash: 'c1', subject: 'One' }],
    ],
    [
      'git:commitFiles', ['C:/repo', 'abc123'],
      `git.listCommitFiles(["C:/repo","abc123",${hosts}])`, [{ status: 'M', path: 'src/c.ts' }],
    ],
    [
      'git:commitDiff', ['C:/repo', 'abc123', 'src/c.ts'],
      `git.getCommitFileDiff(["C:/repo","abc123","src/c.ts",${hosts}])`,
      'DIFF one file of one commit',
    ],
    [
      'git:branches', ['C:/repo'], `git.listCachedBranches(["C:/repo",${hosts}])`,
      { current: 'feature/x', local: ['feature/x', 'main'], remote: ['origin/main'] },
    ],
    ['git:isRepo', ['C:/repo'], `git.isGitRepoCached(["C:/repo",${hosts}])`, true],
    [
      'git:getRemoteUrl', ['C:/repo'], `git.getRemoteUrl(["C:/repo",${hosts}])`,
      'https://example.test/r.git',
    ],
    [
      'git:hostingProvider', ['C:/repo'],
      `git.detectGitHostingProviderCached(["C:/repo",${hosts}])`, 'github',
    ],
    ['git:defaultBranch', ['C:/repo'], `git.getCachedDefaultBranch(["C:/repo",${hosts}])`, 'main'],
    [
      'git:findMergedBranches', ['C:/repo'], `git.findMergedBranches(["C:/repo",${hosts}])`,
      ['feature/done'],
    ],
    [
      'git:generateCommitMessage', ['C:/repo'],
      `git.generateCommitMessage(["C:/repo",${hosts}])`, 'feat: from the diff',
    ],
    [
      'git:generateCommitMessageWithContext', ['C:/repo', ['src/a.ts'], 'the conversation so far'],
      `git.generateCommitMessageWithContext(["C:/repo",["src/a.ts"],"the conversation so far",${hosts}])`,
      'feat: from the conversation',
    ],
    [
      'git:generateBranchName', ['C:/repo'], `git.generateBranchName(["C:/repo",${hosts}])`,
      'feature/generated',
    ],
    [
      'git:generatePullRequestText', ['C:/repo', 'main'],
      `git.generatePullRequestText(["C:/repo","main",${hosts}])`,
      { title: 'PR title', description: 'PR body' },
    ],
    // The two mutations in this batch whose shape is otherwise a plain read. Their *absence*
    // of a cache invalidation is asserted by the exact-log assertion below, and spelled out
    // in the two dedicated tests that follow.
    [
      'git:forceUnlock', ['C:/repo'], `git.forceUnlockRepo(["C:/repo",${hosts}])`,
      { removed: ['index.lock'] },
    ],
    [
      'git:deleteBranches', ['C:/repo', ['feature/done']],
      `git.deleteBranches(["C:/repo",["feature/done"],${hosts}])`,
      { deleted: ['feature/done'], failed: [] },
    ],
  ]

  for (const [channel, args, call, result] of cases) {
    it(`${channel} resolves the host config, forwards it in the ssh/wsl slots, and returns the answer`, async () => {
      const ipc = await viaIpc(channel, args)
      const rpc = await viaControlRpc(channel, args)

      expect(rpc).toEqual(ipc)
      // Exactly two entries: the config lookup and the one git call. Nothing else — no
      // second lookup, and in particular no `git.invalidateGitCache`.
      expect(ipc).toEqual([lookup, call])
      expect(await resultViaIpc(channel, args)).toEqual(result)
      expect(await resultViaControlRpc(channel, args)).toEqual(result)
    })
  }

  it('git:log coalesces an omitted or explicitly null opts to {}', async () => {
    // Load-bearing, and for the *parameter default* reason rather than the in-body one:
    // `listCommits` declares `opts: {…} = {}`, which fires on `undefined` only. A remote
    // caller's explicitly-`undefined` argument arrives as `null` over JSON, sails straight
    // past that default, and `opts.range` would throw on it. Both pre-fold paths coalesced.
    const expected = [lookup, `git.listCommits(["C:/repo",{},${hosts}])`]

    expect(await viaIpc('git:log', ['C:/repo'])).toEqual(expected)
    expect(await viaControlRpc('git:log', ['C:/repo'])).toEqual(expected)
    expect(await viaIpc('git:log', ['C:/repo', null])).toEqual(expected)
    expect(await viaControlRpc('git:log', ['C:/repo', null])).toEqual(expected)
  })

  it('git:log leaves a partially-populated opts object exactly as it arrived', async () => {
    // The coalesce must not become a merge: `listCommits` supplies its own `range`/`limit`
    // defaults in its body, so materialising them here would move that decision.
    const expected = [lookup, `git.listCommits(["C:/repo",{"limit":5},${hosts}])`]
    expect(await viaIpc('git:log', ['C:/repo', { limit: 5 }])).toEqual(expected)
    expect(await viaControlRpc('git:log', ['C:/repo', { limit: 5 }])).toEqual(expected)
  })

  it('git:fetchRemote has no handler-level invalidation — the callee owns it', async () => {
    // The precedent every other `git.ts` mutation now follows: `gitFetchRemoteCached`
    // invalidates *inside* its own `readWithCache`, after the fetch resolves, so a second
    // invalidation here would be a duplicate. The stub replaces that body, so what this pins is
    // the absence at the handler level — which is now the whole family's shape, not this
    // channel's peculiarity.
    const ipc = await viaIpc('git:fetchRemote', ['C:/repo'])
    const rpc = await viaControlRpc('git:fetchRemote', ['C:/repo'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      lookup,
      `git.gitFetchRemoteCached(["C:/repo",${hosts}])`,
      // Awaited rather than floated. This is the only observable proof of it: post-fold the
      // handler cannot return the value, because the contract declares `void`.
      'git.gitFetchRemoteCached:settled',
    ])
    // The one deliberate change the fold makes to this family, and it is a *value* change,
    // not a timing one: both pre-fold paths returned the promise and so resolved
    // `{ fetched: true }`, while the contract declares `void` and `satisfies` refuses that
    // return — so the handler awaits and drops it. Unobservable: stores/git.ts:388 discards
    // the value and the channel is absent from mobile's allowlist (apps/mobile/src/api/rpc.ts).
    expect(await resultViaIpc('git:fetchRemote', ['C:/repo'])).toBeUndefined()
    expect(await resultViaControlRpc('git:fetchRemote', ['C:/repo'])).toBeUndefined()
  })

  it('git:forceUnlock mutates the repo and invalidates nothing, on either path', async () => {
    // `forceUnlockRepo` deletes `.git/index.lock` and friends. The handler does not invalidate
    // afterwards and neither does `git.ts`, so a `git:status` read cached during the locked
    // period survives the unlock for up to its 5 s TTL — even though stores/git.ts:379
    // re-reads status immediately afterwards precisely to refresh that view. Now that every
    // other `git.ts` mutation self-invalidates, this is a visible inconsistency rather than an
    // undocumented one; still reported rather than fixed here, because it is a behaviour change
    // and belongs in its own commit with its own test.
    const ipc = await viaIpc('git:forceUnlock', ['C:/repo'])
    const rpc = await viaControlRpc('git:forceUnlock', ['C:/repo'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([lookup, `git.forceUnlockRepo(["C:/repo",${hosts}])`])
    expect(ipc.some((entry) => entry.includes('invalidateGitCache'))).toBe(false)
  })

  it('git:deleteBranches reaches the mutation, which now clears the branch cache', async () => {
    // This test used to record the opposite: `deleteBranches` mutated branch state and nothing
    // invalidated, so a deleted branch kept showing for up to the 30 s `'branches'` TTL while
    // stores/git.ts:449 re-read `git:branches` the moment the delete resolved. It was preserved
    // through the fold so the fix would not hide inside a refactor, and is now fixed in
    // `git.ts` alongside `forceUnlockRepo`.
    //
    // The invalidation is no longer visible from here — this file mocks `git.ts`, so every
    // mutating handler's log looks alike. What this still pins is that the handler reaches the
    // mutation with the right arguments and adds nothing of its own; the cache behaviour is
    // asserted against the real module in `git-cache-invalidation.test.ts`.
    const ipc = await viaIpc('git:deleteBranches', ['C:/repo', ['feature/done']])
    const rpc = await viaControlRpc('git:deleteBranches', ['C:/repo', ['feature/done']])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([lookup, `git.deleteBranches(["C:/repo",["feature/done"],${hosts}])`])
    expect(ipc.some((entry) => entry.includes('invalidateGitCache'))).toBe(false)

    // The contrast that makes it a bug rather than a design used to be visible right here: the
    // two neighbouring branch mutations invalidated at the handler level, so their call logs
    // showed it. They now invalidate inside `git.ts`, which this file mocks, so the contrast is
    // no longer expressible as a log difference — every mutating handler's log looks like this
    // one. It lives in `git-cache-invalidation.test.ts` instead, where `checkoutBranch` and
    // `createBranch` are shown clearing the cache against the real module.
    const checkout = await viaIpc('git:checkout', ['C:/repo', 'main'])
    expect(checkout).toEqual([
      lookup, `git.checkoutBranch(["C:/repo","main",${hosts}])`, 'git.checkoutBranch:settled',
    ])
  })

  it('git:watchStart hands the window and the invalidation callback to the watcher', async () => {
    // `invalidateRepoGitCache` is passed as a *reference*, not a call: the watcher fires it
    // on every repo change it sees. Calling it here instead would invalidate once,
    // immediately, and leave the watcher with `undefined` — and the recorded call would look
    // almost identical, because the recorder renders a function argument as an empty slot.
    // Hence the identity assertion, and the "no invalidateGitCache" one.
    const { invalidateRepoGitCache } = await import('../ipc/thread-context')

    const ipc = await viaIpc('git:watchStart', ['C:/repo'])
    const ipcCallback = H.state.repoWatchCallback
    const rpc = await viaControlRpc('git:watchStart', ['C:/repo'])

    expect(rpc).toEqual(ipc)
    // The trailing comma inside the brackets is the callback's slot: present, but rendered
    // empty because `JSON.stringify(fn)` is `undefined`. Its presence pins the argument
    // count and order; `ipcCallback` below pins which function it is.
    expect(ipc).toEqual([`fileWatch.startRepoGitWatch([${JSON.stringify(window)},"C:/repo",])`])
    // Both transports resolve the same BrowserWindow — the IPC path closed over the one
    // `registerIpcHandlers` was given, the control-RPC path took it as a parameter.
    expect(ipcCallback).toBe(invalidateRepoGitCache)
    expect(H.state.repoWatchCallback).toBe(invalidateRepoGitCache)
    // Keyed on the path alone: no getConfigForPath, and nothing invalidated up front.
    expect(ipc.some((entry) => entry.includes('getLocationByPath'))).toBe(false)
    expect(ipc.some((entry) => entry.includes('invalidateGitCache'))).toBe(false)

    expect(await resultViaIpc('git:watchStart', ['C:/repo'])).toBe(true)
    expect(await resultViaControlRpc('git:watchStart', ['C:/repo'])).toBe(true)
  })

  it('git:watchStop stops the watcher without resolving the host config', async () => {
    const ipc = await viaIpc('git:watchStop', ['C:/repo'])
    const rpc = await viaControlRpc('git:watchStop', ['C:/repo'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['fileWatch.stopRepoGitWatch(["C:/repo"])'])
  })
})

/**
 * The 24 `git:*` channels that mutate the repo.
 *
 * Shared shape: resolve `{ ssh, wsl } = getConfigForPath(repoPath)`, then `await` one `git.ts`
 * mutation with both configs in the trailing slots. That is the whole handler.
 *
 * ## WHERE THE INVALIDATION COVERAGE WENT
 *
 * Every sequence in this block used to end with two more entries —
 * `db.getLocationByPath(["C:/repo"])` and `git.invalidateGitCache([…])` — from a trailing
 * `invalidateRepoGitCache(repoPath)` in each handler, which re-read the location row purely to
 * recover the ssh/wsl pair the handler already had. That responsibility now sits in `git.ts`,
 * at the end of each mutation's own body, where the cache lives and the two configs are already
 * parameters.
 *
 * This file mocks `../git` wholesale, so the invalidation is no longer observable from here at
 * all — deleting those two entries per sequence would have silently dropped the only assertion
 * in the suite that any git mutation invalidates anything, across ~24 channels. It did not move
 * to nowhere: **`git-cache-invalidation.test.ts`** asserts it against the real `git.ts`, by
 * observing whether a cached read re-runs its git commands after a mutation (rather than by
 * spying on a function name, which cannot tell a correct cache scope from a wrong one). It also
 * covers the scoping — repo A vs repo B, and ssh vs local for one path — and the per-file
 * invalidation that fixes `git:discardFiles`' partial-failure staleness.
 *
 * What this block still pins, and what only it can:
 *
 * - **Ordering.** The handler `await`s the mutation before replying. 18 of the 24 declare
 *   `void`, so a floated promise would return the same value and log the same call — the
 *   `:settled` entry landing before the handler resolves is the only evidence, and it is now
 *   the *only* reason these callees are `H.gitMutation` rather than plain stubs.
 * - **Failure.** A rejecting mutation propagates. `git:publishBranch` is the sole channel that
 *   still invalidates at the handler level, in a `finally`; pinned below.
 * - **Policy.** `git:commit` and `git:amendCommit` are the only two channels that call
 *   `assertMainBranchCommitAllowed`, which throws before the operation runs.
 */
describe('git:* — the 24 channels that mutate the repo', () => {
  beforeEach(() => {
    // DISTINCT configs, for the same reason as the batch above: every one of these 24
    // forwards ssh and wsl in adjacent slots, and the default fixture nulls both.
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
      ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
    }
  })

  const hosts = `${JSON.stringify(DISTINCT_SSH)},${JSON.stringify(DISTINCT_WSL)}`
  const lookup = 'db.getLocationByPath(["C:/repo"])'
  /**
   * What `invalidateRepoGitCache(repoPath)` (thread-context.ts) records: it re-resolves the host
   * config from the DB and then invalidates that scope. Two entries, not one.
   *
   * Only `git:publishBranch` still produces this, and only because its mutation is a *composite*
   * assembled in publish-branch-adapter.ts rather than a single `git.ts` function.
   */
  const invalidation = [lookup, `git.invalidateGitCache(["C:/repo",${hosts}])`]

  /** Drive a transport that is expected to reject, and return the calls it made first. */
  async function callsUntilRejection(
    drive: (channel: string, args: unknown[]) => Promise<unknown>,
    channel: string,
    args: unknown[],
    message: string,
  ): Promise<string[]> {
    H.log.length = 0
    await expect(drive(channel, args)).rejects.toThrow(message)
    return [...H.log]
  }

  /**
   * One row per channel: arguments in, the `git.ts` call(s) out, and the resolved value.
   *
   * The `call` column omits the `:settled` entry — the loop appends it, because it is the same
   * for every row and the point is that no row is missing it. The optional fifth column
   * overrides the derived `:settled` label, which only `discardFileChanges` needs (its stub
   * names the file it settled for).
   */
  const cases: Array<
    [channel: string, args: unknown[], calls: string[], result: unknown, settled?: string]
  > = [
    // The two policy-checked channels. `assertMainBranchCommitAllowed` runs BEFORE the
    // commit and costs a second location lookup plus the project row; with
    // `allow_main_branch_commits: true` it returns before reading git status.
    [
      'git:commit', ['C:/repo', 'a message'],
      [lookup, 'db.getProjectById(["p1"])', `git.commitChanges(["C:/repo","a message",${hosts}])`],
      undefined,
    ],
    [
      'git:amendCommit', ['C:/repo', 'fixup'],
      [lookup, 'db.getProjectById(["p1"])', `git.amendCommit(["C:/repo","fixup",${hosts}])`],
      undefined,
    ],
    ['git:undoLastCommit', ['C:/repo'], [`git.undoLastCommit(["C:/repo",${hosts}])`], undefined],
    // Staging. `git:stage`/`git:unstage` are one transposition apart and so are
    // `stageAll`/`unstageAll`, hence a distinct callee name per row.
    ['git:stage', ['C:/repo', 'src/a.ts'], [`git.stageFile(["C:/repo","src/a.ts",${hosts}])`], undefined],
    ['git:unstage', ['C:/repo', 'src/a.ts'], [`git.unstageFile(["C:/repo","src/a.ts",${hosts}])`], undefined],
    ['git:stageAll', ['C:/repo'], [`git.stageAll(["C:/repo",${hosts}])`], undefined],
    ['git:unstageAll', ['C:/repo'], [`git.unstageAll(["C:/repo",${hosts}])`], undefined],
    [
      'git:stageFiles', ['C:/repo', ['src/a.ts', 'src/b.ts']],
      [`git.stageFiles(["C:/repo",["src/a.ts","src/b.ts"],${hosts}])`], undefined,
    ],
    [
      'git:discardFile', ['C:/repo', 'src/new.ts', 'src/old.ts'],
      [`git.discardFileChanges(["C:/repo","src/new.ts","src/old.ts",${hosts}])`], undefined,
      'git.discardFileChanges:settled("src/new.ts")',
    ],
    ['git:discardAll', ['C:/repo'], [`git.discardAllChanges(["C:/repo",${hosts}])`], undefined],
    // The three whose callee resolves an object the contract declares `void`. Both pre-fold
    // paths returned that object; the fold drops it — see the dedicated test below.
    ['git:push', ['C:/repo'], [`git.gitPush(["C:/repo",${hosts}])`], undefined],
    [
      'git:pushSetUpstream', ['C:/repo', 'feature/x'],
      [`git.gitPushSetUpstream(["C:/repo","feature/x",${hosts}])`], undefined,
    ],
    ['git:pullOrigin', ['C:/repo'], [`git.gitPullOrigin(["C:/repo",${hosts}])`], undefined],
    // `git:pull` with autoStash on — note the literal `true` in the second slot, not the
    // argument. Both branches get their own test below.
    [
      'git:pull', ['C:/repo', true],
      [`git.gitPullWithAutoStash(["C:/repo",true,${hosts}])`],
      { pulled: true, stashed: true, stashRef: 'stash@{0}' },
    ],
    // Stash. All three of apply/pop/drop take `(repoPath, ref)` in that order and reach a
    // distinct callee; a ref is passed through verbatim, with no index arithmetic anywhere.
    [
      'git:stashCreate', ['C:/repo', { message: 'WIP', includeUntracked: true }],
      [`git.createStash(["C:/repo",{"message":"WIP","includeUntracked":true},${hosts}])`], undefined,
    ],
    ['git:stashApply', ['C:/repo', 'stash@{2}'], [`git.applyStash(["C:/repo","stash@{2}",${hosts}])`], undefined],
    ['git:stashPop', ['C:/repo', 'stash@{2}'], [`git.popStash(["C:/repo","stash@{2}",${hosts}])`], undefined],
    ['git:stashDrop', ['C:/repo', 'stash@{2}'], [`git.dropStash(["C:/repo","stash@{2}",${hosts}])`], undefined],
    // Branch mutations.
    ['git:checkout', ['C:/repo', 'main'], [`git.checkoutBranch(["C:/repo","main",${hosts}])`], undefined],
    [
      'git:createBranch', ['C:/repo', 'feature/y', 'main', true],
      [`git.createBranch(["C:/repo","feature/y","main",true,${hosts}])`], undefined,
    ],
    [
      'git:merge', ['C:/repo', 'feature/y'], [`git.mergeBranch(["C:/repo","feature/y",${hosts}])`],
      { conflicts: ['src/a.ts'] },
    ],
    ['git:init', ['C:/repo'], [`git.gitInit(["C:/repo",${hosts}])`], undefined],
  ]

  for (const [channel, args, calls, result, settledOverride] of cases) {
    it(`${channel} resolves the host config once, then awaits the operation`, async () => {
      const ipc = await viaIpc(channel, args)
      const rpc = await viaControlRpc(channel, args)

      // The last `git.ts` call in the row is the operation; it must settle before the handler
      // resolves.
      const operation = calls[calls.length - 1]
      const settled = settledOverride ?? `${operation.slice(0, operation.indexOf('('))}:settled`

      expect(rpc).toEqual(ipc)
      expect(ipc, channel).toEqual([lookup, ...calls, settled])
      // No handler-level invalidation, and — visible in the exact log above — no trailing
      // `db.getLocationByPath` either: that second lookup was `invalidateRepoGitCache`
      // re-deriving ssh/wsl from the DB, and the callee has both as arguments. Asserted
      // separately so a reader of a failure sees which half changed. Where the invalidation is
      // asserted now: this block's doc comment.
      expect(ipc.some((entry) => entry.includes('invalidateGitCache')), channel).toBe(false)
      expect(await resultViaIpc(channel, args), channel).toEqual(result)
      expect(await resultViaControlRpc(channel, args), channel).toEqual(result)
    })
  }

  it('git:push, git:pushSetUpstream and git:pullOrigin drop their callee\'s value — a deliberate change', async () => {
    // The `git:fetchRemote` case again, and forced rather than chosen: `gitPush` and
    // `gitPushSetUpstream` resolve `{ pushed: true }` and `gitPullOrigin` `{ pulled: true }`,
    // the contract declares all three `void`, and `ChannelResult<C> | Promise<ChannelResult<C>>`
    // is a union — so the void-return exemption does not apply and `satisfies` refuses the
    // pass-through. Both pre-fold paths returned the object.
    //
    // Unobservable: stores/git.ts:275,286,311 await and discard all three, and mobile does the
    // same (GitPanel.tsx:134,136). What the fold changes is that the implementation now agrees
    // with the contract it was violating.
    //
    // The awaits stay — the `:settled` entries in the table above are the proof, and they are
    // now the *only* proof, because the value can no longer show it.
    for (const [channel, args] of [
      ['git:push', ['C:/repo']],
      ['git:pushSetUpstream', ['C:/repo', 'feature/x']],
      ['git:pullOrigin', ['C:/repo']],
    ] as Array<[string, unknown[]]>) {
      expect(await resultViaIpc(channel, args), channel).toBeUndefined()
      expect(await resultViaControlRpc(channel, args), channel).toBeUndefined()
    }
  })

  it('git:discardFiles discards one file at a time', async () => {
    const files = [{ path: 'src/a.ts' }, { path: 'src/new.ts', oldPath: 'src/old.ts' }]
    const ipc = await viaIpc('git:discardFiles', ['C:/repo', files])
    const rpc = await viaControlRpc('git:discardFiles', ['C:/repo', files])

    expect(rpc).toEqual(ipc)
    // Sequential, not `Promise.all`: each discard settles before the next one starts. Both
    // pre-fold paths wrote a `for … of` with an `await` inside, and concurrent discards of
    // paths that share an index lock is not the same operation.
    //
    // There is no single trailing invalidation any more, and that is the fix rather than a
    // loss: `discardFileChanges` invalidates per file, so the partial-failure case below no
    // longer leaves a stale cache. Pinned in `git-cache-invalidation.test.ts`.
    expect(ipc).toEqual([
      lookup,
      `git.discardFileChanges(["C:/repo","src/a.ts",null,${hosts}])`,
      'git.discardFileChanges:settled("src/a.ts")',
      `git.discardFileChanges(["C:/repo","src/new.ts","src/old.ts",${hosts}])`,
      'git.discardFileChanges:settled("src/new.ts")',
    ])
  })

  it('git:discardFiles keeps going after a failure and reports every failed path', async () => {
    // The partial-failure contract, identical on both pre-fold paths: one bad file must not
    // abort the rest, and the summary names each failure with its own message. The count and
    // the `file`/`files` pluralisation are part of the message the UI shows.
    H.state.discardFailures = ['src/b.ts', 'src/c.ts']
    const files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }]

    const ipc = await callsUntilRejection(
      resultViaIpc, 'git:discardFiles', ['C:/repo', files],
      'Failed to discard 2 files: src/b.ts (cannot discard src/b.ts); src/c.ts (cannot discard src/c.ts)',
    )
    H.state.discardFailures = ['src/b.ts', 'src/c.ts']
    const rpc = await callsUntilRejection(
      resultViaControlRpc, 'git:discardFiles', ['C:/repo', files],
      'Failed to discard 2 files: src/b.ts (cannot discard src/b.ts); src/c.ts (cannot discard src/c.ts)',
    )

    expect(rpc).toEqual(ipc)
    // All three attempted — the good one first, then both failures. The handler still reaches no
    // invalidation of its own, because the summary throw precedes where that line used to be;
    // the difference is that `src/a.ts`'s successful discard has already invalidated on its own
    // way out, so the repo that really did change no longer keeps a stale cache. That is
    // asserted where it is observable: `git-cache-invalidation.test.ts`, "a bulk discard that
    // fails part-way leaves no stale cache".
    expect(ipc).toEqual([
      lookup,
      `git.discardFileChanges(["C:/repo","src/a.ts",null,${hosts}])`,
      'git.discardFileChanges:settled("src/a.ts")',
      `git.discardFileChanges(["C:/repo","src/b.ts",null,${hosts}])`,
      'git.discardFileChanges:settled("src/b.ts")',
      `git.discardFileChanges(["C:/repo","src/c.ts",null,${hosts}])`,
      'git.discardFileChanges:settled("src/c.ts")',
    ])

    // A single failure says "1 file", not "1 files".
    H.state.discardFailures = ['src/b.ts']
    await callsUntilRejection(
      resultViaIpc, 'git:discardFiles', ['C:/repo', files],
      'Failed to discard 1 file: src/b.ts (cannot discard src/b.ts)',
    )
    H.state.discardFailures = ['src/b.ts']
    await callsUntilRejection(
      resultViaControlRpc, 'git:discardFiles', ['C:/repo', files],
      'Failed to discard 1 file: src/b.ts (cannot discard src/b.ts)',
    )
  })

  it('git:discardFiles with an empty list resolves the config and does nothing else', async () => {
    // This used to end in an invalidation for a repo nothing had touched. It now costs one
    // location lookup and no git work at all — the same reasoning as `stageFiles`' empty-list
    // early return in git.ts: nothing mutated, so nothing cached went stale.
    const ipc = await viaIpc('git:discardFiles', ['C:/repo', []])
    const rpc = await viaControlRpc('git:discardFiles', ['C:/repo', []])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([lookup])
  })

  it('git:commit and git:amendCommit refuse a commit on main before running it', async () => {
    // The two policy-checked channels, and the ordering is the whole point: the check runs
    // BEFORE the operation, so a refusal leaves the repo untouched — and therefore, since the
    // callee is what invalidates and the callee never runs, leaves the cache alone too.
    H.state.project = { id: 'p1', allow_main_branch_commits: false }
    H.state.gitStatus = { branch: 'main' }
    const refusal = 'Commits are disabled on main for this project'

    for (const [channel, args] of [
      ['git:commit', ['C:/repo', 'm']],
      ['git:amendCommit', ['C:/repo', 'm']],
    ] as Array<[string, unknown[]]>) {
      const ipc = await callsUntilRejection(resultViaIpc, channel, args, refusal)
      const rpc = await callsUntilRejection(resultViaControlRpc, channel, args, refusal)

      expect(rpc).toEqual(ipc)
      expect(ipc, channel).toEqual([
        lookup,
        lookup,
        'db.getProjectById(["p1"])',
        // The status read the policy check needs; it only happens once the project has
        // opted out, which is why the happy-path rows above show no `getCachedGitStatus`.
        `git.getCachedGitStatus(["C:/repo",${hosts}])`,
      ])
      // Neither the commit nor the invalidation ran.
      expect(ipc.some((entry) => entry.includes('commitChanges')), channel).toBe(false)
      expect(ipc.some((entry) => entry.includes('amendCommit')), channel).toBe(false)
      expect(ipc.some((entry) => entry.includes('invalidateGitCache')), channel).toBe(false)
    }
  })

  it('git:pull branches on autoStash, and passes a literal true rather than the argument', async () => {
    // `gitPullWithAutoStash(repoPath, true, …)` — the second argument is a literal, so the
    // function's own `if (!autoStash)` fallback is unreachable from this channel. Anything
    // falsy, including omitted and an explicit null off the wire, takes the plain `gitPull`.
    const plain = [lookup, `git.gitPull(["C:/repo",${hosts}])`, 'git.gitPull:settled']

    for (const args of [['C:/repo'], ['C:/repo', null], ['C:/repo', false]]) {
      expect(await viaIpc('git:pull', args), JSON.stringify(args)).toEqual(plain)
      expect(await viaControlRpc('git:pull', args), JSON.stringify(args)).toEqual(plain)
    }

    // …and the value comes straight back from whichever callee ran. `gitPull` resolves
    // `{ pulled: true }` with no `stashed` field, which the contract's PullResult declares
    // as required — a pre-existing mismatch, preserved.
    expect(await resultViaIpc('git:pull', ['C:/repo'])).toEqual({ pulled: true })
    expect(await resultViaControlRpc('git:pull', ['C:/repo'])).toEqual({ pulled: true })
  })

  it('git:discardFile coalesces an omitted or null oldPath to null', async () => {
    // Both pre-fold paths wrote `oldPath ?? null`. It is NOT load-bearing for the callee:
    // `discardFileChanges` guards with `if (oldPath && oldPath !== filePath)`, a truthiness
    // test that treats `undefined` and `null` identically, and nothing else reads it. Kept
    // because it is what both paths recorded, and pinned here so that removing it shows up
    // as the log change it is rather than as nothing at all.
    const expected = [
      lookup,
      `git.discardFileChanges(["C:/repo","src/a.ts",null,${hosts}])`,
      'git.discardFileChanges:settled("src/a.ts")',
    ]

    for (const args of [['C:/repo', 'src/a.ts'], ['C:/repo', 'src/a.ts', null]]) {
      expect(await viaIpc('git:discardFile', args)).toEqual(expected)
      expect(await viaControlRpc('git:discardFile', args)).toEqual(expected)
    }
  })

  it('git:amendCommit coalesces an omitted or null message to null', async () => {
    // Same shape and the same verdict as `oldPath` above: `amendCommit` tests
    // `message != null && message.length > 0`, so `undefined` and `null` are already
    // equivalent to it, and the parameter has no default to sail past. Inert, preserved.
    const expected = [
      lookup,
      lookup,
      'db.getProjectById(["p1"])',
      `git.amendCommit(["C:/repo",null,${hosts}])`,
      'git.amendCommit:settled',
    ]

    for (const args of [['C:/repo'], ['C:/repo', null], ['C:/repo', undefined]]) {
      expect(await viaIpc('git:amendCommit', args)).toEqual(expected)
      expect(await viaControlRpc('git:amendCommit', args)).toEqual(expected)
    }
  })

  it('git:stashCreate coalesces a missing opts to {} — load-bearing, unlike the two above', async () => {
    // `createStash` reads `opts.includeUntracked` with no parameter default, so `undefined`
    // or `null` here is a TypeError rather than a no-op. The contract declares `opts`
    // required, but the renderer's stash button and any remote caller can still omit it —
    // and over the wire an explicitly-`undefined` argument arrives as `null`.
    const expected = [
      lookup, `git.createStash(["C:/repo",{},${hosts}])`, 'git.createStash:settled',
    ]

    for (const args of [['C:/repo'], ['C:/repo', null]]) {
      expect(await viaIpc('git:stashCreate', args)).toEqual(expected)
      expect(await viaControlRpc('git:stashCreate', args)).toEqual(expected)
    }
  })

  it('a failing operation propagates and adds nothing after the rejection', async () => {
    // What this pins post-move: the rejection reaches the caller on both transports, and the
    // handler does no bookkeeping after it — the operation's `:settled` is the last entry.
    //
    // The property it USED to pin, that a failure skipped the invalidation, is preserved rather
    // than dropped: the callee's `invalidateGitCache` sits at the END of its body, not in a
    // `finally`, so a throw still skips it. That is now a `git.ts` fact and is asserted there —
    // `git-cache-invalidation.test.ts`, "a mutation that throws leaves the cache alone". The
    // sole exception remains `git:publishBranch`, below.
    for (const [channel, args, operation] of [
      ['git:commit', ['C:/repo', 'm'], 'git.commitChanges'],
      ['git:stage', ['C:/repo', 'src/a.ts'], 'git.stageFile'],
      ['git:checkout', ['C:/repo', 'main'], 'git.checkoutBranch'],
      ['git:stashApply', ['C:/repo', 'stash@{0}'], 'git.applyStash'],
    ] as Array<[string, unknown[], string]>) {
      H.state.gitShouldFail = true
      const ipc = await callsUntilRejection(resultViaIpc, channel, args, 'git exploded')
      H.state.gitShouldFail = true
      const rpc = await callsUntilRejection(resultViaControlRpc, channel, args, 'git exploded')

      expect(rpc, channel).toEqual(ipc)
      expect(ipc[ipc.length - 1], channel).toBe(`${operation}:settled`)
      expect(ipc.some((entry) => entry.includes('invalidateGitCache')), channel).toBe(false)
    }
  })

  it('git:publishBranch is now the only mutating channel that invalidates at the handler level', async () => {
    // Kept deliberately, and it is now the *only* `invalidateRepoGitCache` left in the mutating
    // family. The reason it is different: `publishRepositoryBranch` is not a `git.ts` function
    // but a composite that calls several of them — `createBranch`, `stageAll`,
    // `commitChangesAndGetHash` (→ `commitChanges`) and `gitPush`, every one of which now
    // invalidates on its own way out — plus `forge.createPullRequest`, which touches no local
    // git state.
    //
    // So this handler invalidates several times per publish instead of once. Harmless:
    // `invalidateGitCache` deletes keys from two Maps and is idempotent. What the `finally` buys
    // is the only invalidation that survives a failure *inside* a step, since each callee
    // invalidates at the end of its own body — and it costs one `db.getLocationByPath` on a
    // rare, user-initiated, network-bound operation. Note also that a `PublishBranchError` comes
    // back as a resolved `{ ok: false }` rather than a rejection, so `finally` vs. a trailing
    // statement is close to moot in practice.
    const input = { repoPath: 'C:/repo', title: 'T', description: 'D', target: 'main' }
    const ipc = await viaIpc('git:publishBranch', [input])
    const rpc = await viaControlRpc('git:publishBranch', [input])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      lookup,
      `publishBranch.publishRepositoryBranch([${JSON.stringify(input)},${hosts}])`,
      // Awaited inside the `try`, so the result is the publish's and not the finally's.
      'publishBranch.publishRepositoryBranch:settled',
      ...invalidation,
    ])

    const result = { ok: true, branch: 'feature/x', pullRequest: { id: 7 } }
    expect(await resultViaIpc('git:publishBranch', [input])).toEqual(result)
    expect(await resultViaControlRpc('git:publishBranch', [input])).toEqual(result)
  })

  it('git:publishBranch invalidates even when the publish fails — alone in this batch', async () => {
    // `try { return await … } finally { … }`, so unlike every sibling above the invalidation
    // survives a rejection. Worth having: publishBranch is multi-step (branch, stage, commit,
    // push, PR) and a step that mutates and then throws before reaching its own trailing
    // invalidation leaves the cache stale.
    const input = { repoPath: 'C:/repo', title: 'T', description: 'D', target: 'main' }

    H.state.publishShouldFail = true
    const ipc = await callsUntilRejection(resultViaIpc, 'git:publishBranch', [input], 'publish exploded')
    H.state.publishShouldFail = true
    const rpc = await callsUntilRejection(
      resultViaControlRpc, 'git:publishBranch', [input], 'publish exploded',
    )

    expect(rpc).toEqual(ipc)
    expect(ipc.slice(-2)).toEqual(invalidation)
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

/**
 * An ssh location that also carries a wsl config.
 *
 * Used by every describe below that hands *both* configs to one callee — the default
 * fixture nulls both, so a transposed `getSshConfigForThread`/`getWslConfigForThread`
 * would be invisible.
 */
const sshAndWslThread = (): void => {
  H.state.location = {
    id: 'loc1', project_id: 'p1', path: 'C:/repo', connection_type: 'ssh',
    ssh: DISTINCT_SSH, wsl: DISTINCT_WSL,
  }
}

describe('sessions:* and messages:* — both transports agree', () => {
  it('sessions:list returns the rows in order', async () => {
    const ipc = await viaIpc('sessions:list', ['t1'])
    const rpc = await viaControlRpc('sessions:list', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.listSessions(["t1"])'])

    // Two rows, so a handler that reversed or re-sorted them would fail — the session
    // switcher lists them in creation order.
    const rows = [
      { id: 's1', thread_id: 't1', name: 'Session one', is_active: true },
      { id: 's2', thread_id: 't1', name: 'Session two', is_active: false },
    ]
    expect(await resultViaIpc('sessions:list', ['t1'])).toEqual(rows)
    expect(await resultViaControlRpc('sessions:list', ['t1'])).toEqual(rows)
  })

  it('sessions:getActive', async () => {
    const ipc = await viaIpc('sessions:getActive', ['t1'])
    const rpc = await viaControlRpc('sessions:getActive', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.getActiveSession(["t1"])'])
    const row = { id: 's1', thread_id: 't1', name: 'Session one', is_active: true }
    expect(await resultViaIpc('sessions:getActive', ['t1'])).toEqual(row)
    expect(await resultViaControlRpc('sessions:getActive', ['t1'])).toEqual(row)
  })

  it('sessions:switch resolves the host context, creates the session, then switches', async () => {
    // Distinct ssh/wsl: getOrCreate takes the two adjacent, and this channel is the only
    // one in this batch that reaches it.
    sshAndWslThread()
    const args = ['t1', 's2']
    const ipc = await viaIpc('sessions:switch', args)
    const rpc = await viaControlRpc('sessions:switch', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'db.threadExists(["t1"])',
      // getEffectiveWorkingDir
      'db.getLocationForThread(["t1"])',
      // getSshConfigForThread
      'db.getLocationForThread(["t1"])',
      // getWslConfigForThread
      'db.getLocationForThread(["t1"])',
      'sessionManager.getOrCreate(["t1","C:/repo",' + JSON.stringify(window) +
        ',' + JSON.stringify(DISTINCT_SSH) + ',' + JSON.stringify(DISTINCT_WSL) + '])',
      'session.switchSession(["s2"])',
    ])
  })

  it('sessions:switch is a no-op for a thread that no longer exists', async () => {
    H.state.threadExists = false

    const ipc = await viaIpc('sessions:switch', ['t1', 's2'])
    const rpc = await viaControlRpc('sessions:switch', ['t1', 's2'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['db.threadExists(["t1"])'])
  })

  it('messages:list and messages:listBySession key off different columns', async () => {
    // The two fixtures differ, so a handler that called the wrong query would still return
    // a plausible-looking message list.
    expect(await viaControlRpc('messages:list', ['t1'])).toEqual(await viaIpc('messages:list', ['t1']))
    expect(await viaIpc('messages:list', ['t1'])).toEqual(['db.listMessages(["t1"])'])
    expect(await resultViaIpc('messages:list', ['t1'])).toEqual([
      { id: 'm1', role: 'user', content: 'by thread' },
    ])
    expect(await resultViaControlRpc('messages:list', ['t1'])).toEqual([
      { id: 'm1', role: 'user', content: 'by thread' },
    ])

    expect(await viaControlRpc('messages:listBySession', ['s1'])).toEqual(
      await viaIpc('messages:listBySession', ['s1']),
    )
    expect(await viaIpc('messages:listBySession', ['s1'])).toEqual([
      'db.listMessagesBySession(["s1"])',
    ])
    expect(await resultViaIpc('messages:listBySession', ['s1'])).toEqual([
      { id: 'm2', role: 'assistant', content: 'by session' },
    ])
    expect(await resultViaControlRpc('messages:listBySession', ['s1'])).toEqual([
      { id: 'm2', role: 'assistant', content: 'by session' },
    ])
  })
})

describe('ssh:test / wsl:* — both transports agree', () => {
  it('ssh:test forwards (config, path) in that order and awaits the probe', async () => {
    const args = [DISTINCT_SSH, '/srv/repo']
    const ipc = await viaIpc('ssh:test', args)
    const rpc = await viaControlRpc('ssh:test', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      `hostTests.testSshConnection([${JSON.stringify(DISTINCT_SSH)},"/srv/repo"])`,
      'hostTests.testSshConnection:settled',
    ])
    expect(await resultViaIpc('ssh:test', args)).toEqual({ ok: true })
    expect(await resultViaControlRpc('ssh:test', args)).toEqual({ ok: true })
  })

  it('wsl:test forwards (config, path) in that order and awaits the probe', async () => {
    const args = [DISTINCT_WSL, '/home/me/repo']
    const ipc = await viaIpc('wsl:test', args)
    const rpc = await viaControlRpc('wsl:test', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      `hostTests.testWslConnection([${JSON.stringify(DISTINCT_WSL)},"/home/me/repo"])`,
      'hostTests.testWslConnection:settled',
    ])
    // A distinct answer from ssh:test, so the two probes cannot be swapped undetected.
    expect(await resultViaIpc('wsl:test', args)).toEqual({ ok: false, error: 'no distro' })
    expect(await resultViaControlRpc('wsl:test', args)).toEqual({ ok: false, error: 'no distro' })
  })

  it('wsl:list-distros takes no arguments and returns the list in order', async () => {
    const ipc = await viaIpc('wsl:list-distros', [])
    const rpc = await viaControlRpc('wsl:list-distros', [])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'hostTests.listWslDistros([])',
      'hostTests.listWslDistros:settled',
    ])
    expect(await resultViaIpc('wsl:list-distros', [])).toEqual(['Ubuntu', 'Debian'])
    expect(await resultViaControlRpc('wsl:list-distros', [])).toEqual(['Ubuntu', 'Debian'])
  })
})

describe('cli:* — both transports agree', () => {
  // Distinct ssh/wsl: these two take the pair adjacent in the argument list and the cache
  // key is derived from both, so a transposition would key the cache wrongly rather than
  // fail outright.
  const args = ['claude-code', 'ssh', DISTINCT_SSH, DISTINCT_WSL]
  const rendered = `["claude-code","ssh",${JSON.stringify(DISTINCT_SSH)},${JSON.stringify(DISTINCT_WSL)}]`

  it('cli:health forwards all four arguments and does NOT touch the cache', async () => {
    const ipc = await viaIpc('cli:health', args)
    const rpc = await viaControlRpc('cli:health', args)

    expect(rpc).toEqual(ipc)
    // The absence of an invalidate call is the behaviour: only cli:update busts the cache.
    expect(ipc).toEqual([`cli.checkCliHealth(${rendered})`, 'cli.checkCliHealth:settled'])
    expect(await resultViaIpc('cli:health', args)).toEqual({ installed: true, currentVersion: '1.2.3' })
    expect(await resultViaControlRpc('cli:health', args)).toEqual({
      installed: true, currentVersion: '1.2.3',
    })
  })

  it('cli:update invalidates the health cache AFTER the update settles', async () => {
    const ipc = await viaIpc('cli:update', args)
    const rpc = await viaControlRpc('cli:update', args)

    expect(rpc).toEqual(ipc)
    // Ordering is the point: invalidating before the await would race a stale re-read back
    // into the cache while the install was still running.
    expect(ipc).toEqual([
      `cli.updateCli(${rendered})`,
      'cli.updateCli:settled',
      `cli.invalidateCliHealthCache(${rendered})`,
    ])
    expect(await resultViaIpc('cli:update', args)).toEqual({ success: true, output: 'updated' })
    expect(await resultViaControlRpc('cli:update', args)).toEqual({
      success: true, output: 'updated',
    })
  })

  it('both pass omitted ssh/wsl through raw', async () => {
    // Neither path coalesces, and neither needs to: getTransportCacheKey and the runners
    // below it all treat a missing host config as "local".
    const local = ['claude-code', 'local']
    expect(await viaIpc('cli:health', local)).toEqual([
      'cli.checkCliHealth(["claude-code","local",undefined,undefined])',
      'cli.checkCliHealth:settled',
    ])
    expect(await viaControlRpc('cli:health', local)).toEqual([
      'cli.checkCliHealth(["claude-code","local",undefined,undefined])',
      'cli.checkCliHealth:settled',
    ])
  })
})

describe('process:kill — both transports agree', () => {
  // A wsl location, so the resolved config is distinguishable from the default null.
  const wslThread = (): void => {
    H.state.location = {
      id: 'loc1', project_id: 'p1', path: '/home/me/repo', connection_type: 'wsl',
      ssh: null, wsl: DISTINCT_WSL,
    }
  }

  it('kills by pid, resolving the wsl config from the thread first', async () => {
    wslThread()
    const args = ['1234', 'pid', 't1']
    const ipc = await viaIpc('process:kill', args)
    const rpc = await viaControlRpc('process:kill', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'db.getLocationForThread(["t1"])',
      `processControl.killByPid([1234,${JSON.stringify(DISTINCT_WSL)}])`,
      'processControl.killByPid:settled',
    ])
    expect(await resultViaIpc('process:kill', args)).toEqual({ ok: true })
    expect(await resultViaControlRpc('process:kill', args)).toEqual({ ok: true })
  })

  it('kills by port when the type is "port"', async () => {
    wslThread()
    const args = ['3000', 'port', 't1']
    const ipc = await viaIpc('process:kill', args)
    const rpc = await viaControlRpc('process:kill', args)

    expect(rpc).toEqual(ipc)
    // The branch is `type === 'pid' ? killByPid : killByPort`, so only one of the two runs.
    expect(ipc).toEqual([
      'db.getLocationForThread(["t1"])',
      `processControl.killByPort([3000,${JSON.stringify(DISTINCT_WSL)}])`,
      'processControl.killByPort:settled',
    ])
  })

  it('passes a null wsl config when threadId is omitted', async () => {
    // `threadId ? getWslConfigForThread(threadId) : null` — plain truthiness, so an omitted
    // thread never reaches the DB at all.
    const args = ['1234', 'pid']
    const ipc = await viaIpc('process:kill', args)
    const rpc = await viaControlRpc('process:kill', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'processControl.killByPid([1234,null])',
      'processControl.killByPid:settled',
    ])
  })

  it('refuses a non-numeric target before touching the thread or the process table', async () => {
    const args = ['not-a-number', 'pid', 't1']
    const ipc = await viaIpc('process:kill', args)
    const rpc = await viaControlRpc('process:kill', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([])
    // The exact string is what the renderer shows in the toast.
    const refusal = { ok: false, error: 'Invalid number' }
    expect(await resultViaIpc('process:kill', args)).toEqual(refusal)
    expect(await resultViaControlRpc('process:kill', args)).toEqual(refusal)
  })

  it('parses a trailing-garbage target the way parseInt does', async () => {
    // `parseInt('80abc', 10)` is 80, not NaN — pinned because `Number('80abc')` is NaN and
    // the two are easy to swap while "reads a number out of a string" stays true.
    const args = ['80abc', 'port']
    expect(await viaIpc('process:kill', args)).toEqual([
      'processControl.killByPort([80,null])',
      'processControl.killByPort:settled',
    ])
    expect(await viaControlRpc('process:kill', args)).toEqual([
      'processControl.killByPort([80,null])',
      'processControl.killByPort:settled',
    ])
  })

  it('converts a rejection into { ok: false, error } rather than throwing', async () => {
    H.state.killError = 'Access denied'
    const args = ['1234', 'pid']

    // The whole point of this channel's shape: the renderer gets a result object, not a
    // rejected invoke, so the error message must survive verbatim.
    const failure = { ok: false, error: 'Access denied' }
    expect(await resultViaIpc('process:kill', args)).toEqual(failure)
    expect(await resultViaControlRpc('process:kill', args)).toEqual(failure)
  })
})

describe('skills:list — both transports agree', () => {
  it('reshapes detected skills onto the SlashCommand row, tagged kind: skill', async () => {
    const args = ['claude-code', 'C:/repo']
    const ipc = await viaIpc('skills:list', args)
    const rpc = await viaControlRpc('skills:list', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['skills.listDetectedSkills(["claude-code","C:/repo"])'])

    // The reshape is the whole behaviour: `invocation` is copied into `prompt`, the array
    // index becomes `sort_order`, `scope === 'project'` becomes a synthetic project_id, and
    // the `kind: 'skill'` tag is what the renderer branches on to tell these apart from
    // stored slash commands on the same palette.
    const expected = [
      {
        id: 'sk1', project_id: 'project', name: 'review', description: 'Review the diff',
        prompt: '/review', sort_order: 0, created_at: '', updated_at: '', kind: 'skill',
        scope: 'project', harness: 'claude-code', path: 'C:/repo/.claude/skills/review',
        invocation: '/review',
      },
      {
        id: 'sk2', project_id: null, name: 'deploy', description: null,
        prompt: '/deploy', sort_order: 1, created_at: '', updated_at: '', kind: 'skill',
        scope: 'global', harness: 'claude-code', path: 'C:/home/.claude/skills/deploy',
        invocation: '/deploy',
      },
    ]
    expect(await resultViaIpc('skills:list', args)).toEqual(expected)
    expect(await resultViaControlRpc('skills:list', args)).toEqual(expected)
  })

  it('coalesces an omitted or null cwd to null', async () => {
    // Both pre-fold paths wrote `cwd ?? null`. Behaviourally redundant — listDetectedSkills
    // branches on `if (cwd)` in its own body, so `undefined`, `null` and `''` are already
    // equivalent there — but it is what both paths did and it is observable in the call.
    expect(await viaIpc('skills:list', ['claude-code'])).toEqual([
      'skills.listDetectedSkills(["claude-code",null])',
    ])
    expect(await viaControlRpc('skills:list', ['claude-code'])).toEqual([
      'skills.listDetectedSkills(["claude-code",null])',
    ])
    expect(await viaIpc('skills:list', ['claude-code', null])).toEqual([
      'skills.listDetectedSkills(["claude-code",null])',
    ])
    expect(await viaControlRpc('skills:list', ['claude-code', null])).toEqual([
      'skills.listDetectedSkills(["claude-code",null])',
    ])
  })
})

describe('terminal:* — both transports agree', () => {
  /**
   * `terminal:spawn` mints `term-${threadId}-${Date.now()}`, so the two transports would
   * otherwise disagree purely on the millisecond they ran in.
   */
  const frozenNow = 1_767_225_600_000
  const freezeClock = (): void => { vi.spyOn(Date, 'now').mockReturnValue(frozenNow) }

  it('terminal:spawn resolves cwd and both host configs into ptyManager.spawn', async () => {
    freezeClock()
    sshAndWslThread()
    const args = ['t1', 120, 40]
    const ipc = await viaIpc('terminal:spawn', args)
    const rpc = await viaControlRpc('terminal:spawn', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      // The location guard, then the same three context lookups every session channel makes.
      'db.getLocationForThread(["t1"])',
      'db.getLocationForThread(["t1"])',
      'db.getLocationForThread(["t1"])',
      'db.getLocationForThread(["t1"])',
      // (terminalId, threadId, cwd, connectionType, cols, rows, ssh, wsl) — the connection
      // type comes from the location row, not from which config happens to be set.
      `ptyManager.spawn(["term-t1-${frozenNow}","t1","C:/repo","ssh",120,40,` +
        `${JSON.stringify(DISTINCT_SSH)},${JSON.stringify(DISTINCT_WSL)}])`,
    ])

    freezeClock()
    sshAndWslThread()
    expect(await resultViaIpc('terminal:spawn', args)).toBe(`term-t1-${frozenNow}`)
    freezeClock()
    sshAndWslThread()
    expect(await resultViaControlRpc('terminal:spawn', args)).toBe(`term-t1-${frozenNow}`)
    vi.restoreAllMocks()
  })

  it('terminal:spawn refuses a thread with no location', async () => {
    H.state.location = null

    await expect(viaIpc('terminal:spawn', ['t1', 120, 40])).rejects.toThrow(
      'No location associated with this thread',
    )
    await expect(viaControlRpc('terminal:spawn', ['t1', 120, 40])).rejects.toThrow(
      'No location associated with this thread',
    )
  })

  it('terminal:write, resize, kill and getBuffer forward to the pty manager', async () => {
    // NOTE: `terminal:write`/`terminal:resize` are registered TWICE in ipc/handlers.ts —
    // once as `ipcMain.on` (what the renderer actually uses, via window.api.send) and once
    // as an `invoke` handler. `viaIpc` reaches the `invoke` one, which is the registration
    // the channel registry and the contract describe.
    expect(await viaControlRpc('terminal:write', ['term-1', 'ls\r'])).toEqual(
      await viaIpc('terminal:write', ['term-1', 'ls\r']),
    )
    expect(await viaIpc('terminal:write', ['term-1', 'ls\r'])).toEqual([
      'ptyManager.write(["term-1","ls\\r"])',
    ])

    expect(await viaControlRpc('terminal:resize', ['term-1', 100, 30])).toEqual(
      await viaIpc('terminal:resize', ['term-1', 100, 30]),
    )
    expect(await viaIpc('terminal:resize', ['term-1', 100, 30])).toEqual([
      'ptyManager.resize(["term-1",100,30])',
    ])

    expect(await viaControlRpc('terminal:kill', ['term-1'])).toEqual(
      await viaIpc('terminal:kill', ['term-1']),
    )
    expect(await viaIpc('terminal:kill', ['term-1'])).toEqual(['ptyManager.kill(["term-1"])'])

    expect(await viaControlRpc('terminal:getBuffer', ['term-1'])).toEqual(
      await viaIpc('terminal:getBuffer', ['term-1']),
    )
    expect(await viaIpc('terminal:getBuffer', ['term-1'])).toEqual([
      'ptyManager.getBuffer(["term-1"])',
    ])
    expect(await resultViaIpc('terminal:getBuffer', ['term-1'])).toBe('buffered terminal output')
    expect(await resultViaControlRpc('terminal:getBuffer', ['term-1'])).toBe(
      'buffered terminal output',
    )
  })

  it('the fire-and-forget terminal:write/resize listeners stay outside the registry', async () => {
    // `ipcMain.on` channels are deliberately not part of CHANNEL_REGISTRY's remit, and the
    // renderer reaches these two through `window.api.send`. They are a separate transport
    // shape from the `invoke` registrations above and are not folded.
    expect(ipcListeners.has('terminal:write')).toBe(true)
    expect(ipcListeners.has('terminal:resize')).toBe(true)

    H.log.length = 0
    await ipcListeners.get('terminal:write')!({}, 'term-1', 'ls\r')
    // The listener awaits the remote hop before writing, so drain the microtask queue.
    await Promise.resolve()
    expect(H.log).toEqual(['ptyManager.write(["term-1","ls\\r"])'])

    H.log.length = 0
    await ipcListeners.get('terminal:resize')!({}, 'term-1', 100, 30)
    await Promise.resolve()
    expect(H.log).toEqual(['ptyManager.resize(["term-1",100,30])'])
  })

  it('the ipcMain.on listeners forward to an active host instead of writing locally', async () => {
    // This is the LIVE terminal transport, so its remote hop carries every keystroke typed
    // at a remotely-controlled terminal. With no active host the forwarding and
    // non-forwarding shapes log identically, so the test above cannot tell them apart:
    // replacing the whole invokeIfActive body with a bare ptyManager.write passed it.
    H.state.remoteProxy = { handled: true, value: undefined }

    H.log.length = 0
    await ipcListeners.get('terminal:write')!({}, 'term-1', 'ls')
    await Promise.resolve()
    expect(H.log).toEqual(['remoteClient.invokeIfActive(["terminal:write",["term-1","ls"]])'])
    expect(H.log.some((entry) => entry.startsWith('ptyManager.write'))).toBe(false)

    H.log.length = 0
    await ipcListeners.get('terminal:resize')!({}, 'term-1', 100, 30)
    await Promise.resolve()
    expect(H.log).toEqual(['remoteClient.invokeIfActive(["terminal:resize",["term-1",100,30]])'])
    expect(H.log.some((entry) => entry.startsWith('ptyManager.resize'))).toBe(false)
  })
})

/**
 * `attachments:*` is the only family that spans all three reachability shapes:
 * `save`/`cleanup` are local *and* remote, `getFileInfo`/`saveFromPath` are local-only, and
 * `readDataUrl` is remote-only. Each shape is pinned from both directions — where it is
 * reachable, and where it must stay unreachable.
 */
describe('attachments:* — all three reachability shapes', () => {
  it('attachments:save forwards (dataUrl, filename, threadId) in that order', async () => {
    const args = ['data:image/png;base64,AAAA', 'shot.png', 't1']
    const ipc = await viaIpc('attachments:save', args)
    const rpc = await viaControlRpc('attachments:save', args)

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual([
      'attachments.saveAttachment(["data:image/png;base64,AAAA","shot.png","t1"])',
    ])
    const saved = { tempPath: 'C:/tmp/att/saved.png', id: 'att-saved' }
    expect(await resultViaIpc('attachments:save', args)).toEqual(saved)
    expect(await resultViaControlRpc('attachments:save', args)).toEqual(saved)
  })

  it('attachments:cleanup removes the thread directory', async () => {
    const ipc = await viaIpc('attachments:cleanup', ['t1'])
    const rpc = await viaControlRpc('attachments:cleanup', ['t1'])

    expect(rpc).toEqual(ipc)
    expect(ipc).toEqual(['attachments.cleanupThreadAttachments(["t1"])'])
  })

  it('attachments:readDataUrl is remote-only — no ipcMain registration at all', async () => {
    expect(CHANNEL_REGISTRY['attachments:readDataUrl']).toMatchObject({
      local: false, remote: true,
    })
    // The registry says `local: false`, and that must mean "not registered", not merely
    // "blocked by the preload allowlist" — the ipcMain registration is the second layer of
    // the same trust boundary.
    expect(ipcHandlers.has('attachments:readDataUrl')).toBe(false)

    H.state.fileBytes = Buffer.from('PNGDATA')
    const expectedPath = join('C:/tmp/polycode-attachments', 't1', 'shot.png')
    const rpc = await viaControlRpc('attachments:readDataUrl', ['t1', 'shot.png'])
    expect(rpc).toEqual([
      'attachments.getAttachmentDir([])',
      `attachments.getFileInfo([${JSON.stringify(expectedPath)}])`,
    ])
    expect(await resultViaControlRpc('attachments:readDataUrl', ['t1', 'shot.png'])).toBe(
      `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
    )
  })

  it('attachments:readDataUrl strips path traversal from both the thread id and the filename', async () => {
    H.state.fileBytes = Buffer.from('PNGDATA')
    // basename() on each segment is the whole defence: a remote client controls both.
    const expectedPath = join('C:/tmp/polycode-attachments', 'other', 'evil.png')
    const rpc = await viaControlRpc('attachments:readDataUrl', [
      '../../other', '../../../etc/evil.png',
    ])
    expect(rpc).toContain(`attachments.getFileInfo([${JSON.stringify(expectedPath)}])`)
    expect(basename('../../../etc/evil.png')).toBe('evil.png')
  })

  it('attachments:readDataUrl returns null for a missing file, an oversized one, or a read error', async () => {
    H.state.fileInfo = null
    expect(await resultViaControlRpc('attachments:readDataUrl', ['t1', 'shot.png'])).toBe(null)

    // 15 MB is the RPC body limit; one byte over must refuse rather than truncate.
    H.state.fileInfo = { size: 15 * 1024 * 1024 + 1, mimeType: 'image/png' }
    expect(await resultViaControlRpc('attachments:readDataUrl', ['t1', 'shot.png'])).toBe(null)

    // Exactly at the limit is allowed — the test above would also pass against `>=`.
    H.state.fileInfo = { size: 15 * 1024 * 1024, mimeType: 'image/png' }
    H.state.fileBytes = Buffer.from('OK')
    expect(await resultViaControlRpc('attachments:readDataUrl', ['t1', 'shot.png'])).toBe(
      `data:image/png;base64,${Buffer.from('OK').toString('base64')}`,
    )
  })

  it('attachments:getFileInfo is local-only — registered on ipcMain, refused over control RPC', async () => {
    expect(CHANNEL_REGISTRY['attachments:getFileInfo']).toMatchObject({
      local: true, remote: false,
    })
    expect(ipcHandlers.has('attachments:getFileInfo')).toBe(true)

    const ipc = await viaIpc('attachments:getFileInfo', ['C:/tmp/shot.png'])
    expect(ipc).toEqual(['attachments.getFileInfo(["C:/tmp/shot.png"])'])
    expect(await resultViaIpc('attachments:getFileInfo', ['C:/tmp/shot.png'])).toEqual({
      size: 1234, mimeType: 'image/png',
    })

    await expect(handleControlRpc(window, 'attachments:getFileInfo', ['C:/tmp/shot.png']))
      .rejects.toThrow('Unsupported remote control channel: attachments:getFileInfo')
  })

  it('attachments:saveFromPath is local-only, and reads the source file before copying it', async () => {
    expect(CHANNEL_REGISTRY['attachments:saveFromPath']).toMatchObject({
      local: true, remote: false,
    })
    H.state.fileBytes = Buffer.from('PNGDATA')

    const ipc = await viaIpc('attachments:saveFromPath', ['C:/pics/shot.png', 't1'])
    expect(ipc).toEqual(['attachments.copyAttachmentFromPath(["C:/pics/shot.png","t1"])'])

    H.state.fileBytes = Buffer.from('PNGDATA')
    H.state.fileReads = 0
    // The `dataUrl` is NOT in the channel contract, but the renderer destructures it
    // (InputBar.tsx) — so it is live behaviour and the mime type is derived from the source
    // path's extension, not from the copy's.
    expect(await resultViaIpc('attachments:saveFromPath', ['C:/pics/shot.png', 't1'])).toEqual({
      tempPath: 'C:/tmp/att/copied.png',
      id: 'att-copied',
      dataUrl: `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
    })
    // Exactly one read. The adapter asks whether a remote host is active BEFORE encoding,
    // so with none the source file is read once, by the handler. Encoding unconditionally
    // in the adapter — which the fold briefly did — reads and base64s every attachment
    // twice on the common path.
    expect(H.state.fileReads).toBe(1)

    await expect(handleControlRpc(window, 'attachments:saveFromPath', ['C:/pics/shot.png', 't1']))
      .rejects.toThrow('Unsupported remote control channel: attachments:saveFromPath')
  })

  it('attachments:saveFromPath uploads to the active remote host instead of copying locally', async () => {
    // The one remote hop in the whole IPC adapter that is NOT "same channel, same args":
    // a source path on this machine is meaningless to the host, so the file is read here
    // and uploaded as an `attachments:save`. Dropping this would silently save a
    // remote-controlled thread's attachment on the wrong machine.
    H.state.fileBytes = Buffer.from('PNGDATA')
    H.state.remoteProxy = { handled: true, value: { tempPath: '/srv/att/remote.png', id: 'att-remote' } }

    const dataUrl = `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`
    const ipc = await viaIpc('attachments:saveFromPath', ['C:/pics/shot.png', 't1'])
    expect(ipc).toEqual([
      `remoteClient.invokeIfActive(["attachments:save",[${JSON.stringify(dataUrl)},"shot.png","t1"]])`,
    ])
    // Note what is absent: no local copy is made.
    expect(ipc.some((entry) => entry.startsWith('attachments.copyAttachmentFromPath'))).toBe(false)

    H.state.fileBytes = Buffer.from('PNGDATA')
    expect(await resultViaIpc('attachments:saveFromPath', ['C:/pics/shot.png', 't1'])).toEqual({
      tempPath: '/srv/att/remote.png',
      id: 'att-remote',
      dataUrl,
    })
  })
})

describe('the ipcMain adapter only pays for the remote hop where it can pay off', () => {
  it('a local-only folded channel never consults the remote client', async () => {
    // `proxyable` calls `invokeIfActive`, which reads the active host from settings — a
    // SQLite read — before consulting `shouldProxy`. For a `remote: false` channel that
    // read can only ever lead to "not handled", and pre-fold these were bare
    // `ipcMain.handle` with no hop at all. `window:is-maximized` fires on every titlebar
    // interaction, so the difference is not academic.
    for (const channel of ['window:is-maximized', 'settings:get', 'app:getVersion', 'remote:getHosts']) {
      expect(CHANNEL_REGISTRY[channel as keyof typeof CHANNEL_REGISTRY]).toMatchObject({
        local: true, remote: false,
      })
      H.state.proxyInvokes = 0
      await viaIpc(channel, channel === 'settings:get' ? ['k'] : [])
      expect(H.state.proxyInvokes).toBe(0)
    }
  })

  it('EVERY dual-path folded channel still takes the hop', async () => {
    // Asserting this for one channel let a targeted loss through: excluding `threads:send`
    // or every `forge:*` from the `isRemoteChannel` branch passed the whole suite, and
    // desktop-A-controlling-desktop-B would break for those channels with nothing red.
    //
    // Args are omitted, so most handlers throw — that is fine and deliberate: `proxyable`
    // awaits `invokeIfActive` BEFORE calling the handler, so the hop is already counted by
    // the time anything can fail.
    const dualPath = MIGRATED_CHANNELS.filter(
      (channel) => isLocalChannel(channel) && isRemoteChannel(channel),
    )
    expect(dualPath.length).toBeGreaterThan(100)

    for (const channel of dualPath) {
      H.state.proxyInvokes = 0
      try {
        await viaIpc(channel, [])
      } catch {
        /* handler needs real args; the hop precedes it */
      }
      expect(H.state.proxyInvokes, `${channel} lost its remote-forwarding hop`).toBe(1)
    }
  })

  it('every local:true channel has an ipcMain registration', async () => {
    // Nothing else asserts the registry and the adapter agree in this direction: a folded
    // channel silently failing to register would surface only as a dead button.
    //
    // This used to carry an exemption for the nine `remote:*` channels registered inside
    // `remote/client.ts`, which this harness mocks away wholesale. They are folded now, so
    // the exemption is gone and the claim is unconditional: every locally-reachable channel
    // in the registry is registered by the MIGRATED_CHANNELS loop, here, in this process.
    expect(LOCAL_CHANNELS.filter((channel) => !ipcHandlers.has(channel))).toEqual([])
  })

  it('the titlebar push listeners are registered', async () => {
    // `window.on(...)` is not a channel, so no other assertion covers it; deleting either
    // line passed the entire suite. The renderer's maximise/restore chrome depends on them.
    expect([...windowListeners.keys()].sort()).toEqual(['maximize', 'unmaximize'])

    H.log.length = 0
    windowListeners.get('maximize')?.()
    windowListeners.get('unmaximize')?.()
    expect(H.log).toEqual([
      'window.send(["window:maximized-changed",true])',
      'window.send(["window:maximized-changed",false])',
    ])
  })
})

describe('plans:getForThread — remote-only', () => {
  it('has no ipcMain registration and is served over control RPC only', async () => {
    expect(CHANNEL_REGISTRY['plans:getForThread']).toMatchObject({ local: false, remote: true })
    expect(ipcHandlers.has('plans:getForThread')).toBe(false)

    const rpc = await viaControlRpc('plans:getForThread', ['t1'])
    expect(rpc).toEqual(['sessionManager.get(["t1"])', 'session.getAssociatedPlan([])'])
    expect(await resultViaControlRpc('plans:getForThread', ['t1'])).toEqual({
      name: 'plan.md', path: 'C:/repo/plan.md', content: '# Plan',
    })
  })

  it('answers null when there is no live session', async () => {
    // `?? null`, not `?.` alone: the contract's result is `T | null`, and an `undefined`
    // would be dropped by JSON.stringify on the way out to the mobile client.
    H.state.hasSession = false
    expect(await resultViaControlRpc('plans:getForThread', ['t1'])).toBe(null)
  })
})

/**
 * The families that only ever had ONE implementation.
 *
 * Every channel below is `{ local: true, remote: false }` and has no `case` in
 * control-rpc.ts, so there is no second implementation to diff against and the
 * `viaIpc`/`viaControlRpc` comparison the rest of this file is built on says nothing. What
 * these pin instead is the triple each one has to keep across the fold:
 *
 *  1. the single implementation's call sequence and return value,
 *  2. that the control-RPC transport still REFUSES the channel — folding must not widen
 *     reachability, and
 *  3. that it IS registered on ipcMain — folding must not narrow it either.
 *
 * (2) is also asserted en masse further below, over every local-only channel at once. It
 * is repeated per channel here because these are the ones being moved, and an en-masse
 * assertion is the one that gets relaxed when it turns red.
 *
 * Most of these channels return nothing. Their behaviour is *which* Electron or Node API
 * they call, with which arguments — hence the recording `shell`/`clipboard`/`dialog` stubs
 * and the recording `window` double, without which a handler that called `openPath` where
 * it should have called `showItemInFolder` would pass every assertion.
 */

/** Refused by the control-RPC dispatcher, and registered on ipcMain. Points (2) and (3). */
async function expectLocalOnly(channel: string, args: unknown[] = []): Promise<void> {
  expect(CHANNEL_REGISTRY[channel as keyof typeof CHANNEL_REGISTRY])
    .toMatchObject({ local: true, remote: false })
  expect(isRemoteChannel(channel)).toBe(false)
  expect(ipcHandlers.has(channel)).toBe(true)
  await expect(handleControlRpc(window, channel, args)).rejects.toThrow(
    `Unsupported remote control channel: ${channel}`,
  )
}

const IS_WIN = process.platform === 'win32'

/**
 * `commandExists` as the recorder renders it. Windows is the primary platform and takes a
 * different probe (`where.exe`, resolved through `%SystemRoot%`) from every other, so the
 * expectation is derived rather than hard-coded — otherwise this file would pin one
 * platform's branch and silently skip the other's.
 */
const probeEntry = (cmd: string): string =>
  IS_WIN
    ? `processControl.runExecFile([${JSON.stringify(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\where.exe`)},["${cmd}"]])`
    : `processControl.runExecFile(["which",["${cmd}"]])`

/** First VS Code launcher tried. On Windows `code.cmd` precedes `code`; elsewhere only `code`. */
const VSCODE_CANDIDATE = IS_WIN ? 'code.cmd' : 'code'

const spawnEntry = (cmd: string, argv: unknown[], options: unknown): string =>
  `proc.spawn([${JSON.stringify(cmd)},${JSON.stringify(argv)},${JSON.stringify(options)}])`

describe('shell:* — local-only, and defined entirely by the side effect', () => {
  it('shell:copyPath writes the path to the clipboard', async () => {
    await expectLocalOnly('shell:copyPath', ['C:/repo'])
    expect(await viaIpc('shell:copyPath', ['C:/repo'])).toEqual(['clipboard.writeText(["C:/repo"])'])
  })

  it('shell:openInExplorer opens the path and does not wait for it', async () => {
    await expectLocalOnly('shell:openInExplorer', ['C:/repo'])
    expect(await viaIpc('shell:openInExplorer', ['C:/repo'])).toEqual(['shell.openPath(["C:/repo"])'])
    // `shell.openPath` resolves to an error string rather than rejecting, and the handler
    // has never surfaced it: the invoke replies immediately and the promise is floated.
    // Pinned because "returns the callee's value" is the rule everywhere else in the map.
    expect(await resultViaIpc('shell:openInExplorer', ['C:/repo'])).toBeUndefined()
  })

  it('shell:revealInExplorer reveals a local path verbatim', async () => {
    await expectLocalOnly('shell:revealInExplorer', ['C:/repo/a.ts'])
    expect(await viaIpc('shell:revealInExplorer', ['C:/repo/a.ts'])).toEqual([
      'db.getLocationByPath(["C:/repo/a.ts"])',
      'shell.showItemInFolder(["C:/repo/a.ts"])',
    ])
  })

  it('shell:revealInExplorer translates a WSL-native path to a UNC path', async () => {
    H.state.location = { ...H.state.location, wsl: DISTINCT_WSL }
    const ipc = await viaIpc('shell:revealInExplorer', ['/home/me/a.ts'])
    // Explorer cannot open a WSL path, so it goes through the \\wsl$ share.
    expect(ipc).toContain(`shell.showItemInFolder([${JSON.stringify('\\\\wsl$\\Ubuntu\\home\\me\\a.ts')}])`)
  })

  it('shell:revealInExplorer maps /mnt/<drive> back to the native Windows path', async () => {
    H.state.location = { ...H.state.location, wsl: DISTINCT_WSL }
    // Going through \\wsl$ for a mounted Windows drive would work but is far slower, and
    // Explorer shows it under a network location rather than the real drive.
    expect(await viaIpc('shell:revealInExplorer', ['/mnt/c/repo/a.ts'])).toContain(
      `shell.showItemInFolder([${JSON.stringify('C:\\repo\\a.ts')}])`,
    )
    // A bare drive root keeps its trailing separator rather than collapsing to "C:".
    expect(await viaIpc('shell:revealInExplorer', ['/mnt/d'])).toContain(
      `shell.showItemInFolder([${JSON.stringify('D:\\')}])`,
    )
  })

  it('shell:revealInExplorer leaves an already-Windows path alone even under WSL', async () => {
    H.state.location = { ...H.state.location, wsl: DISTINCT_WSL }
    expect(await viaIpc('shell:revealInExplorer', ['C:/repo/a.ts'])).toContain(
      'shell.showItemInFolder(["C:/repo/a.ts"])',
    )
  })

  it('shell:revealInExplorer refuses an SSH-hosted path', async () => {
    H.state.location = { ...H.state.location, ssh: DISTINCT_SSH }
    await expect(viaIpc('shell:revealInExplorer', ['/srv/repo/a.ts'])).rejects.toThrow(
      'Cannot reveal files hosted on a remote SSH location.',
    )
  })

  it('shell:openInVsCode launches the first available candidate with a file URI', async () => {
    await expectLocalOnly('shell:openInVsCode', ['C:/repo'])
    const folderUri = pathToFileURL('C:/repo').toString()
    expect(await viaIpc('shell:openInVsCode', ['C:/repo'])).toEqual([
      probeEntry(VSCODE_CANDIDATE),
      spawnEntry(VSCODE_CANDIDATE, ['--folder-uri', folderUri], {
        detached: true, stdio: 'ignore', shell: IS_WIN,
      }),
      'proc.unref([])',
    ])
  })

  it('shell:openInVsCode builds a vscode-remote URI for WSL and for SSH', async () => {
    // ssh/wsl arrive as arguments here rather than from getConfigForPath, so no location
    // fixture is involved — the caller decides which remote authority is addressed.
    const wsl = await viaIpc('shell:openInVsCode', ['C:/repo', null, DISTINCT_WSL])
    expect(wsl[1]).toContain('vscode-remote://wsl+Ubuntu/mnt/c/repo')

    const ssh = await viaIpc('shell:openInVsCode', ['/home/me/repo', DISTINCT_SSH, null])
    expect(ssh[1]).toContain('vscode-remote://ssh-remote+ssh.example.test/home/me/repo')

    // wsl wins when both are supplied — the same precedence the files:* channels use.
    const both = await viaIpc('shell:openInVsCode', ['C:/repo', DISTINCT_SSH, DISTINCT_WSL])
    expect(both[1]).toContain('vscode-remote://wsl+Ubuntu')
  })

  it('shell:openInVsCode falls back to openExternal when no launcher is on PATH', async () => {
    // `commandExists` is a probe, not a guess: with `code` absent the folder URI is handed
    // to the OS, which is what makes the channel work on a machine that has only the
    // VS Code protocol handler registered.
    H.state.execFileFails = true
    const ipc = await viaIpc('shell:openInVsCode', ['C:/repo'])
    expect(ipc.filter((entry) => entry.startsWith('proc.spawn'))).toEqual([])
    expect(ipc.at(-1)).toBe(
      `shell.openExternal([${JSON.stringify(pathToFileURL('C:/repo').toString())}])`,
    )
    // Every candidate is probed before giving up — on Windows that is code.cmd then code.
    expect(ipc.filter((entry) => entry.startsWith('processControl.runExecFile'))).toHaveLength(
      IS_WIN ? 2 : 1,
    )
  })

  it('shell:openInTerminal opens a WSL terminal in the distro, cd-ed to the WSL path', async () => {
    await expectLocalOnly('shell:openInTerminal', ['C:/repo'])
    // Platform-independent: this branch is chosen by the wsl argument, not by the host OS.
    expect(await viaIpc('shell:openInTerminal', ['C:/repo', DISTINCT_WSL])).toEqual([
      spawnEntry('wsl.exe', ['-d', 'Ubuntu', '--cd', '/mnt/c/repo'], {
        detached: true, stdio: 'ignore',
      }),
      'proc.unref([])',
    ])
    // An already-WSL path is passed through rather than mangled by windowsPathToWsl.
    expect(await viaIpc('shell:openInTerminal', ['/home/me/repo', DISTINCT_WSL])).toContain(
      spawnEntry('wsl.exe', ['-d', 'Ubuntu', '--cd', '/home/me/repo'], {
        detached: true, stdio: 'ignore',
      }),
    )
  })

  it('shell:openInTerminal picks the host platform’s terminal when no distro is given', async () => {
    const expected = IS_WIN
      ? spawnEntry('start', ['powershell.exe', '-NoExit', '-Command', "Set-Location 'C:/repo'"], {
        cwd: 'C:/repo', detached: true, stdio: 'ignore', shell: true,
      })
      : process.platform === 'darwin'
        ? spawnEntry('open', ['-a', 'Terminal', 'C:/repo'], { detached: true, stdio: 'ignore' })
        // Linux tries gnome-terminal, konsole, xterm in that order and stops at the first
        // that spawns; the stub never throws, so only the first is reached.
        : spawnEntry('gnome-terminal', [], { cwd: 'C:/repo', detached: true, stdio: 'ignore' })

    expect(await viaIpc('shell:openInTerminal', ['C:/repo'])).toEqual([expected, 'proc.unref([])'])
  })

  it.runIf(IS_WIN)('shell:openInTerminal doubles single quotes for the PowerShell literal', async () => {
    // `Set-Location '…'` is a PowerShell single-quoted string, where the escape for a quote
    // is doubling it. Without this a directory named `it's` breaks the command.
    expect(await viaIpc('shell:openInTerminal', ["C:/it's/repo"])).toContain(
      spawnEntry('start', ['powershell.exe', '-NoExit', '-Command', "Set-Location 'C:/it''s/repo'"], {
        cwd: "C:/it's/repo", detached: true, stdio: 'ignore', shell: true,
      }),
    )
  })
})

describe('window:* — local-only, driven straight off the BrowserWindow', () => {
  it('window:minimize and window:close forward to the window', async () => {
    await expectLocalOnly('window:minimize')
    expect(await viaIpc('window:minimize', [])).toEqual(['window.minimize([])'])

    await expectLocalOnly('window:close')
    expect(await viaIpc('window:close', [])).toEqual(['window.close([])'])
  })

  it('window:maximize toggles, so it reads the state before acting', async () => {
    await expectLocalOnly('window:maximize')

    H.state.isMaximized = false
    expect(await viaIpc('window:maximize', [])).toEqual([
      'window.isMaximized([])', 'window.maximize([])',
    ])

    H.state.isMaximized = true
    expect(await viaIpc('window:maximize', [])).toEqual([
      'window.isMaximized([])', 'window.unmaximize([])',
    ])
  })

  it('window:is-maximized reports the window state', async () => {
    await expectLocalOnly('window:is-maximized')
    expect(await resultViaIpc('window:is-maximized', [])).toBe(false)
    H.state.isMaximized = true
    expect(await resultViaIpc('window:is-maximized', [])).toBe(true)
  })
})

describe('app:* and update:* — local-only', () => {
  it('app:getVersion reports "Local Dev" for an unpackaged non-production run', async () => {
    await expectLocalOnly('app:getVersion')
    // getVersion() is read unconditionally, before the isDev branch — so the version is
    // computed even on the path that throws it away.
    expect(await viaIpc('app:getVersion', [])).toEqual(['app.getVersion([])'])
    expect(await resultViaIpc('app:getVersion', [])).toBe('Local Dev')
  })

  it('app:getVersion prefixes the real version once NODE_ENV is production', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(await resultViaIpc('app:getVersion', [])).toBe('v0.0.0')
    } finally {
      process.env.NODE_ENV = previous
    }
  })

  it('app:open-logs-folder resolves the directory then opens it', async () => {
    await expectLocalOnly('app:open-logs-folder')
    expect(await viaIpc('app:open-logs-folder', [])).toEqual([
      'appLogger.getLogsDirPath([])',
      'shell.openPath(["C:/tmp/polycode-logs"])',
    ])
    // Unlike shell:openInExplorer, this one returns openPath's promise — the renderer shows
    // the error string it resolves to.
    expect(await resultViaIpc('app:open-logs-folder', [])).toBe('RET_openPath')
  })

  it('update:check kicks off a check and answers with the state, not the check', async () => {
    await expectLocalOnly('update:check')
    expect(await viaIpc('update:check', [])).toEqual([
      'updater.checkForUpdates([])',
      'updater.getUpdateState([])',
    ])
    // checkForUpdates is fire-and-forget; the reply is the state as it stands right now.
    expect(await resultViaIpc('update:check', [])).toEqual({ status: 'downloaded', version: '1.2.3' })
  })

  it('update:apply wraps the boolean in { success }', async () => {
    await expectLocalOnly('update:apply')
    expect(await viaIpc('update:apply', [])).toEqual(['updater.applyUpdate([])'])
    expect(await resultViaIpc('update:apply', [])).toEqual({ success: true })
  })

  it('update:get-state reads the state without triggering a check', async () => {
    await expectLocalOnly('update:get-state')
    expect(await viaIpc('update:get-state', [])).toEqual(['updater.getUpdateState([])'])
  })
})

describe('dialog:* — local-only, and the two cancelled shapes differ', () => {
  it('dialog:open-directory returns the single picked path', async () => {
    await expectLocalOnly('dialog:open-directory')
    expect(await viaIpc('dialog:open-directory', [])).toEqual([
      `dialog.showOpenDialog([${JSON.stringify(window)},{"properties":["openDirectory"]}])`,
    ])
    expect(await resultViaIpc('dialog:open-directory', [])).toBe('C:/picked')
  })

  it('dialog:open-directory answers null when cancelled or empty', async () => {
    H.state.dialogResult = { canceled: true, filePaths: [] }
    expect(await resultViaIpc('dialog:open-directory', [])).toBe(null)
    // `?? null` on filePaths[0] as well: a non-cancelled dialog with no selection would
    // otherwise resolve to undefined, which JSON.stringify drops on the way to the renderer.
    H.state.dialogResult = { canceled: false, filePaths: [] }
    expect(await resultViaIpc('dialog:open-directory', [])).toBe(null)
  })

  it('dialog:open-files offers the attachment filters and returns every path', async () => {
    await expectLocalOnly('dialog:open-files')
    H.state.dialogResult = { canceled: false, filePaths: ['C:/a.png', 'C:/b.pdf'] }
    expect(await viaIpc('dialog:open-files', [])).toEqual([
      `dialog.showOpenDialog([${JSON.stringify(window)},${JSON.stringify({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })}])`,
    ])
    expect(await resultViaIpc('dialog:open-files', [])).toEqual(['C:/a.png', 'C:/b.pdf'])
  })

  it('dialog:open-files answers an empty array when cancelled — not null', async () => {
    H.state.dialogResult = { canceled: true, filePaths: [] }
    expect(await resultViaIpc('dialog:open-files', [])).toEqual([])
  })
})

describe('settings:* and webhook:* — local-only', () => {
  it('settings:get and settings:set pass the key straight through', async () => {
    await expectLocalOnly('settings:get', ['k'])
    expect(await viaIpc('settings:get', ['theme'])).toEqual(['db.getSetting(["theme"])'])

    await expectLocalOnly('settings:set', ['k', 'v'])
    expect(await viaIpc('settings:set', ['theme', 'dark'])).toEqual([
      'db.setSetting(["theme","dark"])',
    ])
  })

  it('webhook:getConfig reads the three rows and persists a token on first use', async () => {
    await expectLocalOnly('webhook:getConfig')
    const calls = await viaIpc('webhook:getConfig', [])
    expect(calls.slice(0, 3)).toEqual([
      'db.getSetting(["webhook:enabled"])',
      'db.getSetting(["webhook:port"])',
      'db.getSetting(["webhook:token"])',
    ])
    expect(calls[3]).toMatch(/^db\.setSetting\(\["webhook:token","[0-9a-f]{48}"\]\)$/)
    // The stubbed getSetting answers undefined for every key, which is the never-configured
    // state: disabled and the default port, with a newly generated token.
    expect(await resultViaIpc('webhook:getConfig', [])).toMatchObject({
      enabled: false, port: 3284, token: expect.stringMatching(/^[0-9a-f]{48}$/),
    })
  })

  it('webhook:setConfig persists all three rows BEFORE restarting the server', async () => {
    await expectLocalOnly('webhook:setConfig', [{ enabled: false, port: 1, token: '' }])
    const config = { enabled: true, port: 9999, token: 'tok' }
    expect(await viaIpc('webhook:setConfig', [config])).toEqual([
      'db.setSetting(["webhook:enabled","true"])',
      'db.setSetting(["webhook:port","9999"])',
      'db.setSetting(["webhook:token","tok"])',
      // The restart is handed the incoming config, not a re-read of what was just written,
      // and it comes last — a restart before the write would rebind the old port.
      `webhook.restartWebhookServer([${JSON.stringify(config)},${JSON.stringify(window)}])`,
    ])
  })

  it('webhook:setConfig writes "false" rather than omitting the disabled flag', async () => {
    const calls = await viaIpc('webhook:setConfig', [{ enabled: false, port: 3284, token: '' }])
    expect(calls).toContain(
      'db.setSetting(["webhook:enabled","false"])',
    )
    expect(calls).toEqual(expect.arrayContaining([
      expect.stringMatching(/^db\.setSetting\(\["webhook:token","[0-9a-f]{48}"\]\)$/),
      expect.stringMatching(/^webhook\.restartWebhookServer\(\[\{"enabled":false,"port":3284,"token":"[0-9a-f]{48}"\},/),
    ]))
  })
})

/**
 * The two `remote:*` channels that left `remote/client.ts`.
 *
 * Unlike every other test in this file these could not be run before the fold: this file
 * replaces `../remote/client` wholesale — the mock is what keeps the remote-forwarding hop
 * inert for all the other tests — so the pre-fold `ipcMain.handle('remote:getServerConfig',
 * …)` registrations inside `registerRemoteControlIpcHandlers` never existed here to
 * characterise. Both pre-fold bodies were a single `return <fn>()` with no arguments and no
 * surrounding logic, which is exactly what is asserted below.
 */
describe('remote:getServerConfig and remote:getPairingInfo — folded out of remote/client.ts', () => {
  it('remote:getServerConfig reads the stored server config', async () => {
    await expectLocalOnly('remote:getServerConfig')
    expect(await viaIpc('remote:getServerConfig', [])).toEqual([
      'remoteConfig.readRemoteServerConfig([])',
    ])
    // The token is served in full — the Remote Control settings panel renders it, and the
    // QR pairing code embeds it.
    expect(await resultViaIpc('remote:getServerConfig', [])).toEqual({
      enabled: false, host: '127.0.0.1', port: 3285, token: 'server-token',
    })
  })

  it('remote:getPairingInfo reports this machine’s LAN addresses', async () => {
    await expectLocalOnly('remote:getPairingInfo')
    expect(await viaIpc('remote:getPairingInfo', [])).toEqual(['remoteLan.getPairingInfo([])'])
    expect(await resultViaIpc('remote:getPairingInfo', [])).toEqual({
      addresses: ['192.168.1.10'], hostname: 'desktop-test',
    })
  })

})

/**
 * The nine `remote:*` channels that were the last thing left in `remote/client.ts`.
 *
 * All nine are `{ local: true, remote: false }` and none ever had a `case` in
 * control-rpc.ts, so — like the `shell:*`/`window:*`/`dialog:*` families above — there is
 * no second implementation to diff against. What each has to keep across the fold is the
 * same triple: its single call sequence and return value, that control RPC still REFUSES
 * it, and that it IS registered on ipcMain.
 *
 * Seven of the nine are pure delegation to the `RemoteControlClient` instance, which
 * reaches the handler map as `ctx.remoteClient` — supplied by the ipcMain adapter, which
 * already held it. The instance here is the test double (`H.remoteClient`), so what is
 * pinned is the delegation: which method, which arguments, and that the result comes back
 * untouched. The client's own internals — `emitAppEvent('remote:hosts-changed', …)` and the
 * private `restartEventStream()` — are not observable through the double, and are not
 * touched by the fold either: they stay inside `remote/client.ts` exactly as they were.
 *
 * The other two reach `remote/config.ts` directly and hand the result to the server
 * restart, which the adapter pre-binds to its window as `ctx.restartServer` so the map does
 * not have to plumb it.
 */
describe('the nine client-instance remote:* channels — folded out of remote/client.ts', () => {
  /** A host input as the Remote Control settings panel sends it. */
  const HOST_INPUT: RemoteHostInput = {
    label: 'Studio',
    baseUrl: 'http://192.168.1.10:3285',
    token: 'host-token',
  }

  const SERVER_CONFIG: RemoteServerConfig = {
    enabled: true, host: '0.0.0.0', port: 3300, token: 'chosen-token',
  }

  /**
   * `restartRemoteControlServer(config, window)` as the recorder renders it.
   *
   * The window slot is interpolated rather than spelled out — the point of the assertion is
   * that the *saved* config reaches the restart, and that the restart happens at all.
   */
  const restartEntry = (config: unknown): string =>
    `remoteServer.restartRemoteControlServer([${JSON.stringify(config)},${JSON.stringify(window)}])`

  it('remote:getHosts returns the client’s host list untouched', async () => {
    await expectLocalOnly('remote:getHosts')
    expect(await viaIpc('remote:getHosts', [])).toEqual(['remoteClient.getHosts([])'])
    expect(await resultViaIpc('remote:getHosts', [])).toEqual([H.REMOTE_HOST])
  })

  it('remote:getActiveHost asks the client and does nothing else', async () => {
    await expectLocalOnly('remote:getActiveHost')
    H.state.activeHost = H.REMOTE_HOST
    H.state.proxyChecks = 0
    // `getActiveHost` is counted rather than logged (see the client mock), so the empty log
    // is the assertion that no *other* backend call happens, and the count is the assertion
    // that the client was asked exactly once.
    expect(await viaIpc('remote:getActiveHost', [])).toEqual([])
    expect(H.state.proxyChecks).toBe(1)
    expect(await resultViaIpc('remote:getActiveHost', [])).toEqual(H.REMOTE_HOST)
  })

  it('remote:getActiveHost answers null when no host is active', async () => {
    expect(await resultViaIpc('remote:getActiveHost', [])).toBe(null)
  })

  it('remote:addHost passes the input through verbatim', async () => {
    await expectLocalOnly('remote:addHost', [HOST_INPUT])
    expect(await viaIpc('remote:addHost', [HOST_INPUT])).toEqual([
      `remoteClient.addHost([${JSON.stringify(HOST_INPUT)}])`,
    ])
    // Normalisation (trimming, the `http://` default, the generated id and timestamps) is
    // the client's job and stays there — the handler adds nothing.
    expect(await resultViaIpc('remote:addHost', [HOST_INPUT])).toEqual({
      ...H.REMOTE_HOST, id: 'added',
    })
  })

  it('remote:updateHost passes id and input in that order', async () => {
    await expectLocalOnly('remote:updateHost', ['h1', HOST_INPUT])
    expect(await viaIpc('remote:updateHost', ['h1', HOST_INPUT])).toEqual([
      `remoteClient.updateHost(["h1",${JSON.stringify(HOST_INPUT)}])`,
    ])
    expect(await resultViaIpc('remote:updateHost', ['h1', HOST_INPUT])).toEqual({
      ...H.REMOTE_HOST, id: 'updated',
    })
  })

  it('remote:removeHost resolves nothing', async () => {
    await expectLocalOnly('remote:removeHost', ['h1'])
    expect(await viaIpc('remote:removeHost', ['h1'])).toEqual(['remoteClient.removeHost(["h1"])'])
    // The contract's result is `void`. The client's `removeHost` is the one of the seven
    // that returns nothing, and the renderer re-reads the list from the change event.
    expect(await resultViaIpc('remote:removeHost', ['h1'])).toBeUndefined()
  })

  it('remote:setActiveHost forwards an id', async () => {
    await expectLocalOnly('remote:setActiveHost', ['h1'])
    expect(await viaIpc('remote:setActiveHost', ['h1'])).toEqual([
      'remoteClient.setActiveHost(["h1"])',
    ])
    expect(await resultViaIpc('remote:setActiveHost', ['h1'])).toEqual({
      ...H.REMOTE_HOST, id: 'activated',
    })
  })

  it('remote:setActiveHost forwards a null id verbatim rather than coalescing it', async () => {
    // `null` is the deactivate signal — the client branches on it to clear the setting and
    // tear the SSE stream down. Coalescing it to `undefined` anywhere on the way would take
    // the "host not found" throw instead.
    expect(await viaIpc('remote:setActiveHost', [null])).toEqual([
      'remoteClient.setActiveHost([null])',
    ])
  })

  it('remote:testHost awaits the probe rather than floating it', async () => {
    await expectLocalOnly('remote:testHost', [HOST_INPUT])
    expect(await viaIpc('remote:testHost', [HOST_INPUT])).toEqual([
      `remoteClient.testHost([${JSON.stringify(HOST_INPUT)}])`,
      'remoteClient.testHost:settled',
    ])
    expect(await resultViaIpc('remote:testHost', [HOST_INPUT])).toEqual({ ok: true })
  })

  it('remote:setServerConfig saves first, then restarts with the SAVED config', async () => {
    await expectLocalOnly('remote:setServerConfig', [SERVER_CONFIG])
    // Order matters in both directions: restarting first would rebind the old port, and the
    // restart is handed what `saveRemoteServerConfig` returned — the *normalised* config —
    // not the config that came in off the wire.
    expect(await viaIpc('remote:setServerConfig', [SERVER_CONFIG])).toEqual([
      `remoteConfig.saveRemoteServerConfig([${JSON.stringify(SERVER_CONFIG)}])`,
      restartEntry({ ...SERVER_CONFIG, token: 'normalised-token' }),
    ])
    expect(await resultViaIpc('remote:setServerConfig', [SERVER_CONFIG])).toEqual({
      ...SERVER_CONFIG, token: 'normalised-token',
    })
  })

  it('remote:regenerateServerToken mints a fresh 24-byte token over the stored config', async () => {
    await expectLocalOnly('remote:regenerateServerToken')
    const log = await viaIpc('remote:regenerateServerToken', [])
    expect(log).toHaveLength(3)
    // Read, then write, then restart. The read is what supplies enabled/host/port, so only
    // the token changes — a regenerate that dropped the read would disable the server.
    expect(log[0]).toBe('remoteConfig.readRemoteServerConfig([])')
    expect(log[1]).toMatch(
      /^remoteConfig\.saveRemoteServerConfig\(\[\{"enabled":false,"host":"127\.0\.0\.1","port":3285,"token":"[0-9a-f]{48}"\}\]\)$/,
    )
    expect(log[2]).toBe(restartEntry({
      enabled: false, host: '127.0.0.1', port: 3285, token: 'normalised-token',
    }))
    expect(await resultViaIpc('remote:regenerateServerToken', [])).toEqual({
      enabled: false, host: '127.0.0.1', port: 3285, token: 'normalised-token',
    })
  })

  it('remote:regenerateServerToken mints a different token every time', async () => {
    // Otherwise a hoisted or memoised token would satisfy the assertion above while making
    // the button a no-op — the whole point of the channel is that the old token stops
    // working.
    const tokenOf = (log: string[]): string => /"token":"([0-9a-f]+)"/.exec(log[1])?.[1] ?? ''
    const first = tokenOf(await viaIpc('remote:regenerateServerToken', []))
    const second = tokenOf(await viaIpc('remote:regenerateServerToken', []))
    expect(first).toHaveLength(48)
    expect(second).not.toBe(first)
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
