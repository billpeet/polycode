/**
 * Project and location provisioning logic shared by the local IPC handlers
 * and the remote-control RPC surface (extracted from ipc/handlers.ts).
 */
import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import {
  archiveThread,
  createLocation,
  createProject,
  createWorktreeLocation,
  deleteLocation,
  deleteThread,
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
 * Reconcile PolyCode's local worktree locations with Git's authoritative registry.
 * External worktrees are persisted; stale PolyCode rows remain visible and are marked invalid.
 */
export async function listSyncedLocations(projectId: string): Promise<RepoLocation[]> {
  const locations = listLocations(projectId)
  const validPathsByParent = new Map<string, Set<string>>()
  const localParentIds = new Set(
    locations
      .filter((location) => location.connection_type === 'local' && !location.is_worktree)
      .map((location) => location.id)
  )

  for (const parent of locations.filter((location) =>
    location.connection_type === 'local' && !location.is_worktree
  )) {
    try {
      const records = parseGitWorktreeList(await runGit(['worktree', 'list', '--porcelain', '-z'], parent.path))
      const validPaths = new Set<string>()
      validPathsByParent.set(parent.id, validPaths)
      const registeredForParent = new Set(
        locations
          .filter((location) => location.is_worktree && location.parent_location_id === parent.id)
          .map((location) => comparablePath(location.path))
      )

      for (const record of records) {
        const pathKey = comparablePath(record.path)
        if (record.prunable || !existsSync(record.path) || pathKey === comparablePath(parent.path)) continue
        validPaths.add(pathKey)
        if (!registeredForParent.has(pathKey)) {
          const imported = createWorktreeLocation(parent, basename(record.path), record.path)
          locations.push(imported)
          registeredForParent.add(pathKey)
        }
      }
    } catch (error) {
      console.warn(`[worktree] Could not reconcile worktrees for "${parent.path}":`, error)
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

function removeWorktreeDirectoryBestEffort(path: string): void {
  if (!existsSync(path)) return
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (removeError) {
    const code = removeError && typeof removeError === 'object' && 'code' in removeError
      ? String((removeError as { code?: unknown }).code)
      : ''
    if (code !== 'EBUSY' && code !== 'EPERM') throw removeError
    console.warn(`[worktree] Could not remove locked worktree directory "${path}"; removing PolyCode location only.`)
  }
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

  const currentBranch = (await runGit(['branch', '--show-current'], parent.path)).trim()
  const baseName = sanitizeWorktreeSegment(label || currentBranch || 'worktree')
  const repoName = sanitizeWorktreeSegment(basename(parent.path))
  const worktreesRoot = join(dirname(parent.path), `${repoName}-worktrees`)
  mkdirSync(worktreesRoot, { recursive: true })

  let worktreePath = join(worktreesRoot, baseName)
  let suffix = 2
  while (existsSync(worktreePath)) {
    worktreePath = join(worktreesRoot, `${baseName}-${suffix}`)
    suffix += 1
  }

  const branchName = `polycode/${baseName}-${Date.now().toString(36)}`
  const baseRef = baseRefOverride ?? await resolveWorktreeBaseRef(parent.path)
  await runGit(['worktree', 'add', '-b', branchName, worktreePath, baseRef], parent.path)
  const location = createWorktreeLocation(parent, label?.trim() || baseName, worktreePath)

  for (const command of listCommands(parent.project_id).filter((cmd) => cmd.run_on_worktree_create)) {
    void commandManager.start(command.id, location.id)
  }

  return location
}

/** Remove a worktree location: archive/delete its threads, remove the git worktree, drop the row. */
export async function removeWorktreeLocation(id: string): Promise<void> {
  const location = getLocationById(id)
  if (!location) return
  if (!location.is_worktree) throw new Error('Location is not a worktree.')
  if (location.connection_type !== 'local') throw new Error('Worktree removal is currently supported for local locations only.')
  for (const thread of listActiveThreadsForLocation(location.id)) {
    sessionManager.remove(thread.id)
    if (thread.has_messages) {
      archiveThread(thread.id)
    } else {
      deleteThread(thread.id)
    }
  }
  const parent = location.parent_location_id ? getLocationById(location.parent_location_id) : null
  const gitCwd = parent?.path && existsSync(parent.path) ? parent.path : location.path
  try {
    await runGit(['worktree', 'remove', '--force', location.path], gitCwd)
  } catch (error) {
    if (!isNotRegisteredWorktreeError(error) && !isWorktreeDirectoryCleanupError(error)) throw error
    if (parent?.path && existsSync(parent.path)) {
      await runGit(['worktree', 'prune'], parent.path).catch(() => undefined)
    }
    removeWorktreeDirectoryBestEffort(location.path)
  }
  deleteLocation(id)
}
