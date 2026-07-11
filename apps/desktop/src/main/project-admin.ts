/**
 * Project and location provisioning logic shared by the local IPC handlers
 * and the remote-control RPC surface (extracted from ipc/handlers.ts).
 */
import { spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
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
} from './db/queries'
import { gitInit, getRemoteUrl } from './git'
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
export function cloneRepo(gitUrl: string, clonePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(join(clonePath, '..'), { recursive: true })
    } catch {
      // parent may already exist
    }

    const proc = spawn('git', ['clone', gitUrl, clonePath], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `git clone exited with code ${code}`))
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to run git: ${err.message}`))
    })
  })
}

function sanitizeWorktreeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || `worktree-${Date.now()}`
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.trim() || `git exited with code ${code}`))
    })
    proc.on('error', (err) => reject(new Error(`Failed to run git: ${err.message}`)))
  })
}

async function resolveWorktreeBaseRef(repoPath: string): Promise<string> {
  for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
    try {
      await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)
      return ref
    } catch {
      // Try the next conventional default branch ref.
    }
  }

  throw new Error('Could not find a main or master branch to create the worktree from.')
}

function isNotRegisteredWorktreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('is not a working tree') || message.includes('is not a git repository')
}

function isWorktreeDirectoryCleanupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('failed to delete') && (
    message.includes('Directory not empty') ||
    message.includes('Permission denied')
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

/** Create a git worktree next to the parent checkout and register it. */
export async function createLocalWorktree(parentLocationId: string, label?: string | null): Promise<RepoLocation> {
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
  const baseRef = await resolveWorktreeBaseRef(parent.path)
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
