/**
 * Project and location provisioning logic shared by the local IPC handlers
 * and the remote-control RPC surface (extracted from ipc/handlers.ts).
 */
import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import {
  archiveThreadsForLocation,
  createLocation,
  createProject,
  createWorktreeLocation,
  deleteLocation,
  getLocationById,
  getSetting,
  listActiveThreadsForLocation,
  listCommands,
  listLocations,
} from './db/queries'
import { gitInit, getRemoteUrl, resolveDefaultBranchRef } from './git'
import { createRunner } from './driver/runner'
import { runGit as executeGit } from './git-runner'
import { sessionManager } from './session/manager'
import { commandManager } from './commands/manager'
import { runSerialized } from './keyed-queue'
import { withSpan } from './observability'
import { TtlCache } from './ttl-cache'
import { stopWatchesUnder } from './file-watch'
import { discardDirectory } from './worktree-trash'
import { NewProjectResult, NewProjectSpec, RepoLocation } from '../shared/types'

/** Expand a leading `~` to the user's home directory. */
export function resolveHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p
}

/** Derive a directory-friendly name from a git URL (last path segment, sans `.git`). */
export function repoNameFromGitUrl(gitUrl: string): string {
  return gitUrl.replace(/\.git$/i, '').split(/[/\\]/).filter(Boolean).pop() ?? 'repo'
}

/** Resolve a unique, non-existent path under `baseDir`, appending `-2`, `-3`, … on collision. */
export function suggestUniquePath(baseDir: string, name: string): string {
  const resolvedBase = resolveHome(baseDir)
  const candidate = join(resolvedBase, name)
  if (!existsSync(candidate)) return candidate
  let n = 2
  while (existsSync(join(resolvedBase, `${name}-${n}`))) n++
  return join(resolvedBase, `${name}-${n}`)
}

/** Run `git clone <gitUrl> <clonePath>`, creating the parent directory first. */
export async function cloneRepo(gitUrl: string, clonePath: string): Promise<void> {
  const parentDir = join(clonePath, '..')
  mkdirSync(parentDir, { recursive: true })
  await executeGit(createRunner({}), parentDir, ['clone', gitUrl, clonePath])
}

function sanitizeWorktreeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || `worktree-${Date.now()}`
}

/**
 * The opaque id a worktree's directory and initial branch are both named
 * after. Deliberately says nothing about the parent's checked-out branch or
 * the base ref: the worktree's identity is its *current* branch, which the
 * agent is free to change after creation.
 */
export function createWorktreeId(timestamp: number = Date.now()): string {
  return timestamp.toString(36)
}

/** Worktree branches are intentionally opaque: their name does not describe their base. */
export function createWorktreeBranchName(id: string): string {
  return `polycode/${id}`
}

function runGit(args: string[], cwd: string): Promise<string> {
  return executeGit(createRunner({}), cwd, args)
}

interface GitWorktreeRecord {
  path: string
  prunable: boolean
}

/** Parse the stable, NUL-delimited output of `git worktree list --porcelain -z`. */
export function parseGitWorktreeList(output: string): GitWorktreeRecord[] {
  return output.split('\0\0').flatMap((record) => {
    const fields = record.split('\0').filter(Boolean)
    const worktree = fields.find((field) => field.startsWith('worktree '))
    if (!worktree) return []
    return [{
      path: worktree.slice('worktree '.length),
      prunable: fields.some((field) => field === 'prunable' || field.startsWith('prunable ')),
    }]
  })
}

function comparablePath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Live worktrees git reports for a parent checkout, or null when it is not a checkout.
 * Cached per parent for 30s: a Remote Host's client polls `locations:list` every few
 * seconds, and reading the registry fresh each time cost 13.9k `git worktree list`
 * spawns (plus a stat per record) in 38 hours on one host. PolyCode's own worktree
 * add/remove invalidate the entry; worktrees made outside PolyCode appear within 30s.
 */
const WORKTREE_REGISTRY_TTL_MS = 30_000
type WorktreeRegistry = { records: GitWorktreeRecord[] | null; linked?: boolean } | { error: unknown }
const worktreeRegistry = new TtlCache<WorktreeRegistry>(WORKTREE_REGISTRY_TTL_MS)

function readWorktreeRegistry(parentPath: string) {
  return worktreeRegistry.get(comparablePath(parentPath), async () => {
    try {
      // A location that is not a git checkout (a notes folder, say) has no worktrees to
      // reconcile; without this check every `locations:list` spawned a failing git for it.
      const gitPath = join(parentPath, '.git')
      if (!existsSync(gitPath)) return { records: null }
      // A linked worktree has a `.git` file rather than a directory. Git lists the whole
      // repository's worktrees from inside it, main checkout and siblings included.
      const linked = statSync(gitPath).isFile()
      const records = parseGitWorktreeList(await runGit(['worktree', 'list', '--porcelain', '-z'], parentPath))
      return { records: records.filter((record) => !record.prunable && existsSync(record.path)), linked }
    } catch (error) {
      // Logged once per TTL rather than on every poll.
      console.warn(`[worktree] Could not reconcile worktrees for "${parentPath}":`, error)
      return { error }
    }
  })
}

export function invalidateWorktreeRegistry(parentPath: string): void {
  worktreeRegistry.delete(comparablePath(parentPath))
}

/**
 * Reconcile PolyCode's local worktree locations with Git's authoritative registry.
 * External worktrees are persisted; stale PolyCode rows remain visible and are marked invalid.
 */
export function listSyncedLocations(projectId: string): Promise<RepoLocation[]> {
  // Overlapping calls (sidebar, composer, remote clients) each read the rows before
  // awaiting git, so unserialised they all imported the same worktree. One dev database
  // grew 9k duplicate locations in six seconds that way.
  return runSerialized(`locations:sync:${projectId}`, () => syncLocations(projectId))
}

async function syncLocations(projectId: string): Promise<RepoLocation[]> {
  const locations = listLocations(projectId)
  // Every path the project already knows, under any parent: a worktree is imported once
  // per project, not once per checkout that can see it.
  const knownPaths = new Set(
    locations.filter((location) => location.connection_type === 'local').map((location) => comparablePath(location.path))
  )
  const validPathsByParent = new Map<string, Set<string>>()
  const localParentIds = new Set(
    locations
      .filter((location) => location.connection_type === 'local' && !location.is_worktree)
      .map((location) => location.id)
  )

  for (const parent of locations.filter((location) =>
    location.connection_type === 'local' && !location.is_worktree
  )) {
    const registry = await readWorktreeRegistry(parent.path)
    if ('error' in registry || registry.records === null) continue
    const validPaths = new Set<string>()
    validPathsByParent.set(parent.id, validPaths)

    for (const record of registry.records) {
      const pathKey = comparablePath(record.path)
      if (pathKey === comparablePath(parent.path)) continue
      validPaths.add(pathKey)
      // Only the main checkout adopts worktrees; a location that is itself a linked
      // worktree would otherwise adopt the main checkout and every sibling.
      if (registry.linked || knownPaths.has(pathKey)) continue
      const imported = createWorktreeLocation(parent, basename(record.path), record.path)
      locations.push(imported)
      knownPaths.add(pathKey)
    }
  }

  return locations.map((location) => ({
    ...location,
    worktree_valid: !location.is_worktree
      ? null
      : !location.parent_location_id || !localParentIds.has(location.parent_location_id)
        ? false
        : validPathsByParent.get(location.parent_location_id)?.has(comparablePath(location.path)) ?? null,
  }))
}

/**
 * Default branch for the interactive worktree path: local `main`/`master`
 * first (repos without a remote must keep working), then the shared remote
 * resolution. Delegates to git.ts — the single default-branch policy.
 */
function resolveWorktreeBaseRef(repoPath: string): Promise<string> {
  return resolveDefaultBranchRef(repoPath, { includeLocal: true })
}

function isNotRegisteredWorktreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('is not a working tree') || message.includes('is not a git repository')
}

export function isWorktreeDirectoryCleanupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('failed to delete') && (
    message.includes('Directory not empty') ||
    message.includes('Permission denied') ||
    message.includes('Filename too long')
  )
}

/**
 * Atomically provision a brand-new project *and* its first local location.
 * All filesystem/git work happens BEFORE any DB rows are written, so a
 * failure never leaves an orphaned project behind.
 */
export async function createFullProject(spec: NewProjectSpec): Promise<NewProjectResult> {
  const name = spec.name?.trim()
  if (!name) throw new Error('Project name is required.')
  const label = spec.label?.trim() || 'Local'
  const allow = spec.allowMainBranchCommits ?? true
  const source = spec.source

  let locationPath: string
  let gitUrl: string | null = null

  if (source.kind === 'new') {
    const resolved = resolveHome(source.path?.trim() ?? '')
    if (!resolved) throw new Error('Directory path is required.')
    mkdirSync(resolved, { recursive: true })
    await gitInit(resolved)
    locationPath = resolved
  } else if (source.kind === 'existing') {
    const resolved = resolveHome(source.path?.trim() ?? '')
    if (!resolved) throw new Error('Directory is required.')
    if (!existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`)
    locationPath = resolved
    gitUrl = await getRemoteUrl(resolved).catch(() => null)
  } else if (source.kind === 'clone') {
    const url = source.gitUrl?.trim()
    if (!url) throw new Error('Git URL is required.')
    const parentDir = source.parentDir?.trim() || getSetting('default_source_dir')?.trim() || '~/source'
    locationPath = suggestUniquePath(parentDir, repoNameFromGitUrl(url))
    await cloneRepo(url, locationPath)
    gitUrl = url
  } else {
    throw new Error('Unknown project source.')
  }

  const project = createProject(name, gitUrl, allow)
  const location = createLocation(project.id, label, 'local', locationPath, null, null, null)
  return { project, location }
}

/** Clone a repo and register it as a new location for an existing project. */
export async function cloneLocation(projectId: string, label: string, gitUrl: string, clonePath: string): Promise<RepoLocation> {
  await cloneRepo(gitUrl, clonePath)
  return createLocation(projectId, label, 'local', clonePath, null, null, null)
}

/**
 * Create a git worktree next to the parent checkout and register it.
 * `baseRefOverride` pins the ref the worktree branches from (e.g. a Routine
 * run branching off origin/<default>); otherwise the conventional default
 * branch is resolved.
 */
export async function createLocalWorktree(parentLocationId: string, label?: string | null, baseRefOverride?: string): Promise<RepoLocation> {
  const parent = getLocationById(parentLocationId)
  if (!parent) throw new Error('Parent location not found')
  if (parent.connection_type !== 'local') throw new Error('Worktree creation is currently supported for local locations only.')
  if (parent.is_worktree) throw new Error('Create new worktrees from the main checkout location.')
  if (!existsSync(parent.path)) throw new Error(`Directory not found: "${parent.path}"`)
  return runSerialized(worktreeQueueKey(parent.path), () => createLocalWorktreeUnqueued(parent, label, baseRefOverride))
}

/** Worktree add/remove serialise per parent repository — they share its index lock. */
function worktreeQueueKey(parentPath: string): string {
  return `worktree:${resolve(parentPath).toLowerCase()}`
}

async function createLocalWorktreeUnqueued(parent: RepoLocation, label?: string | null, baseRefOverride?: string): Promise<RepoLocation> {
  const repoName = sanitizeWorktreeSegment(basename(parent.path))
  const worktreesRoot = join(dirname(parent.path), `${repoName}-worktrees`)
  mkdirSync(worktreesRoot, { recursive: true })

  // Directory and branch share one opaque id. Two creations inside the same
  // millisecond (or a leftover directory) simply advance the id.
  let timestamp = Date.now()
  let worktreeId = createWorktreeId(timestamp)
  while (existsSync(join(worktreesRoot, worktreeId))) {
    timestamp += 1
    worktreeId = createWorktreeId(timestamp)
  }
  const worktreePath = join(worktreesRoot, worktreeId)

  const branchName = createWorktreeBranchName(worktreeId)
  const baseRef = baseRefOverride ?? await resolveWorktreeBaseRef(parent.path)
  await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseRef], parent.path)
  invalidateWorktreeRegistry(parent.path)
  // The stored label is only a fallback: the UI names a worktree after its current branch.
  const location = createWorktreeLocation(parent, label?.trim() || worktreeId, worktreePath)

  for (const command of listCommands(parent.project_id).filter((cmd) => cmd.run_on_worktree_create)) {
    void commandManager.start(command.id, location.id)
  }

  return location
}

/** Remove a worktree location: archive its threads, remove the git worktree, drop the row. */
export async function removeWorktreeLocation(id: string): Promise<void> {
  const location = getLocationById(id)
  if (!location) return
  if (!location.is_worktree) throw new Error('Location is not a worktree.')
  if (location.connection_type !== 'local') throw new Error('Worktree removal is currently supported for local locations only.')
  const threads = listActiveThreadsForLocation(location.id)
  // Archive everything up front, before any teardown: the threads must leave
  // the Queue the moment deletion is triggered, not after commands, sessions,
  // and the git worktree have been removed (which can take a long time or
  // fail). Every thread is archived rather than deleting the message-less
  // ones, so the whole worktree stays recoverable from the archive view.
  // Each phase is its own span: a 118s removal traced in Grafana showed 15s of
  // `git worktree remove` and then 103 untraced seconds, so nobody could say
  // whether the time went to the directory delete, the queue, or the sessions.
  const phase = <T>(name: string, operation: () => T | Promise<T>, attributes: Record<string, number> = {}) =>
    withSpan(`worktree.remove.${name}`, { 'worktree.thread_count': threads.length, ...attributes }, operation)
  const archived = await phase('archive-threads', () => archiveThreadsForLocation(location.id))
  if (archived > 0) {
    console.log(`[worktree] Archived ${archived} thread(s) at "${location.path}" before removal.`)
  }
  await phase('stop-commands', () => commandManager.stopAllForLocation(location.id))
  await phase('remove-sessions', () => {
    for (const thread of threads) {
      sessionManager.remove(thread.id)
    }
  })
  const parent = location.parent_location_id ? getLocationById(location.parent_location_id) : null
  const gitCwd = parent?.path && existsSync(parent.path) ? parent.path : location.path
  const queuedAt = performance.now()
  await runSerialized(worktreeQueueKey(parent?.path ?? location.path), async () => {
    const waitedMs = performance.now() - queuedAt
    // A live `fs.watch` holds a Windows handle on the directory, which is one way
    // `git worktree remove` ends in "Permission denied".
    const restoreWatches = stopWatchesUnder(location.path)
    // Rename first, delete later. Letting git delete the tree itself (even with
    // `core.longpaths`) took 50–80s for a worktree full of node_modules and held this
    // queue the whole time; a same-volume rename is milliseconds, after which `prune`
    // drops the registration and the tombstone is deleted on a worker thread.
    const discarded = await phase('move-aside', () => discardDirectory(location.path, { inPlaceFallback: false }), { 'worktree.queue_wait_ms': waitedMs })
    if (discarded.movedTo || !discarded.existed) {
      if (parent?.path && existsSync(parent.path)) {
        await phase('git-prune', () => runGit(['worktree', 'prune'], parent.path).catch(() => undefined))
      }
    } else {
      // Something holds a handle inside the directory, so it could not be moved. Let git
      // try; if git cannot delete it either, delete it in place in the background.
      try {
        await phase('git-remove', () => runGit(['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', location.path], gitCwd))
      } catch (error) {
        if (!isNotRegisteredWorktreeError(error) && !isWorktreeDirectoryCleanupError(error)) {
          // The worktree lives on, so the renderer's subscriptions must too.
          restoreWatches()
          throw error
        }
        await phase('delete-directory', () => discardDirectory(location.path))
        if (parent?.path && existsSync(parent.path)) {
          await phase('git-prune', () => runGit(['worktree', 'prune'], parent.path).catch(() => undefined))
        }
      }
    }
    if (waitedMs >= 1000) {
      console.warn(`[worktree] Removal of "${location.path}" waited ${waitedMs.toFixed(0)}ms behind another worktree operation.`)
    }
  })
  if (parent?.path) invalidateWorktreeRegistry(parent.path)
  await phase('delete-location', () => deleteLocation(id))
}
