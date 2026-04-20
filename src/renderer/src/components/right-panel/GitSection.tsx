import { useCallback, useEffect, useState } from 'react'
import { useFilesStore } from '../../stores/files'
import { useGitStore } from '../../stores/git'
import { useLocationStore } from '../../stores/locations'
import { useThreadStore } from '../../stores/threads'
import { useToastStore } from '../../stores/toast'
import { GitCompareResult, GitFileChange, PullResult, RepoLocation } from '../../types/ipc'
import { ContextMenu, ContextMenuItem } from '../ui/ContextMenu'
import { SectionHeader, SparkleIcon } from './shared'
import { StashSection } from './StashSection'
import { CommitLogSection } from './CommitLogSection'
import { useGitErrorReporter } from '../../lib/gitErrorToast'

/** Join a repo path and a relative file path using the separator style implied by the repo path. */
function joinRepoPath(repoPath: string, relPath: string): string {
  const useBackslash = repoPath.includes('\\')
  const trimmed = repoPath.replace(/[\\/]+$/, '')
  if (useBackslash) {
    return `${trimmed}\\${relPath.replace(/\//g, '\\')}`
  }
  return `${trimmed}/${relPath}`
}

type PullRequestItem = {
  id: number
  title: string
  status: string
  sourceBranch: string
  targetBranch: string
  authorName: string
  url: string
  creationDate: string
}

type BranchMode = 'switch' | 'new' | 'merge' | 'clean'

const EMPTY_FILES: string[] = []
const EMPTY_LOCATIONS: RepoLocation[] = []

function FileStatusBadge({ status, staged }: { status: GitFileChange['status']; staged: boolean }) {
  const label = status === 'M' ? 'M' : status === 'A' ? 'A' : status === 'D' ? 'D' : status === 'R' ? 'R' : status === 'U' ? 'U' : '?'
  const color =
    status === 'M' ? '#e2c08d'
    : status === 'A' ? '#4ade80'
    : status === 'D' ? '#f87171'
    : status === 'R' ? '#a78bfa'
    : status === 'U' ? '#f87171'
    : 'var(--color-text-muted)'

  return (
    <span
      style={{ fontSize: '0.6rem', fontWeight: 700, color, width: 12, textAlign: 'center', flexShrink: 0, opacity: staged ? 1 : 0.65 }}
      title={staged ? 'Staged' : 'Unstaged'}
    >
      {label}
    </span>
  )
}

function basename(p: string): string {
  const s = p.replace(/\/$/, '')
  return s.split('/').pop() ?? s
}

function dirname(p: string): string {
  const s = p.replace(/\/$/, '')
  const parts = s.split('/')
  return parts.length <= 1 ? '' : parts.slice(0, -1).join('/')
}

function DiscardIcon() {
  // Curved backward arrow (revert / discard)
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 3a5 5 0 1 1-4.546 7.914.75.75 0 1 0-1.294.76 6.5 6.5 0 1 0-.16-6.164l-.854-.854a.5.5 0 0 0-.854.354v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .354-.854l-.89-.89A4.99 4.99 0 0 1 8 3z" />
    </svg>
  )
}

function FileGroup({
  label,
  files,
  onFileAction,
  onGroupAction,
  actionIcon = 'plus',
  actionTitle = 'Action',
  showActions = true,
  onFileClick,
  onFileDiscard,
  onGroupDiscard,
  onFileContextMenu,
}: {
  label: string
  files: GitFileChange[]
  onFileAction?: (filePath: string) => void
  onGroupAction?: () => void
  actionIcon?: 'plus' | 'minus'
  actionTitle?: string
  showActions?: boolean
  onFileClick?: (file: GitFileChange) => void
  onFileDiscard?: (file: GitFileChange) => void
  onGroupDiscard?: () => void
  onFileContextMenu?: (file: GitFileChange, event: React.MouseEvent) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div>
      <div className="flex w-full items-center gap-1 px-3 py-1.5 hover:bg-white/5 transition-colors group" style={{ color: 'var(--color-text-muted)' }}>
        <button onClick={() => setCollapsed((c) => !c)} className="flex items-center gap-1 flex-1 text-left">
          <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
            <path d="M0 2l4 4 4-4z" />
          </svg>
          <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
          <span className="ml-1 text-[10px] rounded-full px-1.5" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-muted)' }}>{files.length}</span>
        </button>
        {onGroupDiscard && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onGroupDiscard()
            }}
            className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10 transition-all"
            style={{ color: '#f87171' }}
            title={`Discard All ${label}`}
          >
            <DiscardIcon />
          </button>
        )}
        {showActions && onGroupAction && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onGroupAction()
            }}
            className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10 transition-all"
            title={`${actionTitle} All`}
          >
            {actionIcon === 'plus' ? (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z" /></svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z" /></svg>
            )}
          </button>
        )}
      </div>
      {!collapsed && (
        <ul>
          {files.map((file, idx) => {
            const name = basename(file.path)
            const dir = dirname(file.path)
            return (
              <li
                key={`${file.path}-${idx}`}
                className="flex items-center gap-2 px-4 py-1 hover:bg-white/5 transition-colors group"
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : `${file.path}\n(right-click for more)`}
                onContextMenu={(e) => {
                  if (!onFileContextMenu) return
                  e.preventDefault()
                  e.stopPropagation()
                  onFileContextMenu(file, e)
                }}
              >
                <FileStatusBadge status={file.status} staged={file.staged} />
                <span className="text-xs truncate min-w-0 flex-1" style={{ color: 'var(--color-text)', cursor: onFileClick ? 'pointer' : 'default' }} onClick={() => onFileClick?.(file)}>
                  {name}
                </span>
                {dir && <span className="text-[10px] truncate flex-shrink-0 max-w-[60px] group-hover:hidden" style={{ color: 'var(--color-text-muted)' }}>{dir}</span>}
                {onFileDiscard && (
                  <button
                    onClick={() => onFileDiscard(file)}
                    className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10 transition-all flex-shrink-0"
                    style={{ color: '#f87171' }}
                    title="Discard changes"
                  >
                    <DiscardIcon />
                  </button>
                )}
                {showActions && onFileAction && (
                  <button onClick={() => onFileAction(file.path)} className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10 transition-all flex-shrink-0" title={actionTitle}>
                    {actionIcon === 'plus' ? (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z" /></svg>
                    ) : (
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z" /></svg>
                    )}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function BranchControls({ projectPath, currentBranch, hasPendingChanges }: { projectPath: string; currentBranch: string; hasPendingChanges: boolean }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<BranchMode>('switch')
  const [branchSearch, setBranchSearch] = useState('')
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [mergeFromMaster, setMergeFromMaster] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [newName, setNewName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [pullFirst, setPullFirst] = useState(false)
  const [creating, setCreating] = useState(false)
  const [mergeSource, setMergeSource] = useState('')
  const [merging, setMerging] = useState(false)
  const [mergeConflicts, setMergeConflicts] = useState<string[]>([])
  const [mergedBranches, setMergedBranches] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [selectedForDelete, setSelectedForDelete] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  const branches = useGitStore((s) => s.branchesByPath[projectPath] ?? null)
  const branchLoading = useGitStore((s) => s.branchLoadingByPath[projectPath] ?? false)
  const fetchBranches = useGitStore((s) => s.fetchBranches)
  const checkoutAction = useGitStore((s) => s.checkout)
  const createBranchAction = useGitStore((s) => s.createBranch)
  const mergeAction = useGitStore((s) => s.merge)
  const findMergedAction = useGitStore((s) => s.findMergedBranches)
  const deleteBranchesAction = useGitStore((s) => s.deleteBranches)
  const pullOriginAction = useGitStore((s) => s.pullOrigin)
  const pullingByPath = useGitStore((s) => s.pullingByPath)
  const addToast = useToastStore((s) => s.add)
  const reportGitError = useGitErrorReporter(projectPath)
  const isPullingOrigin = pullingByPath[projectPath] ?? false

  function toggleOpen() {
    if (!open) fetchBranches(projectPath)
    setOpen((value) => !value)
    setSelectedBranch(null)
    setMergeFromMaster(false)
    setBranchSearch('')
  }

  useEffect(() => {
    if (branches && !baseBranch) {
      const defaultBase = branches.local.find((b) => b === 'master' || b === 'main') ?? branches.local[0] ?? ''
      setBaseBranch(defaultBase)
    }
  }, [branches, baseBranch])

  const allBranches = branches ? [...branches.local, ...branches.remote] : []
  const isRemoteSelected = selectedBranch?.startsWith('origin/') ?? false
  const q = branchSearch.toLowerCase()
  const filteredLocal = branches ? branches.local.filter((b) => !q || b.toLowerCase().includes(q)) : []
  const filteredRemote = branches ? branches.remote.filter((b) => !q || b.toLowerCase().includes(q)) : []
  const filteredAll = allBranches.filter((b) => !q || b.toLowerCase().includes(q))

  async function handleSwitch() {
    if (!selectedBranch) return
    setSwitching(true)
    try {
      await checkoutAction(projectPath, selectedBranch)
      if (mergeFromMaster) {
        await mergeAction(projectPath, 'origin/master')
        addToast({ type: 'success', message: `Switched to ${selectedBranch} and merged origin/master`, duration: 3000 })
      } else {
        addToast({ type: 'success', message: `Switched to ${selectedBranch}`, duration: 3000 })
      }
      setSelectedBranch(null)
      setMergeFromMaster(false)
      setOpen(false)
    } catch (err) {
      reportGitError(err, 'Checkout failed')
    } finally {
      setSwitching(false)
    }
  }

  async function handleCreate() {
    if (!newName.trim() || !baseBranch) return
    setCreating(true)
    try {
      await createBranchAction(projectPath, newName.trim(), baseBranch, pullFirst)
      addToast({ type: 'success', message: `Created and switched to ${newName.trim()}`, duration: 3000 })
      setNewName('')
      setOpen(false)
    } catch (err) {
      reportGitError(err, 'Create branch failed')
    } finally {
      setCreating(false)
    }
  }

  async function handleScan() {
    setScanning(true)
    setScanned(false)
    setMergedBranches([])
    setSelectedForDelete(new Set())
    try {
      const merged = await findMergedAction(projectPath)
      setMergedBranches(merged)
      setSelectedForDelete(new Set(merged))
      setScanned(true)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Scan failed', duration: 0 })
    } finally {
      setScanning(false)
    }
  }

  async function handleDeleteBranches() {
    if (selectedForDelete.size === 0) return
    setDeleting(true)
    try {
      const result = await deleteBranchesAction(projectPath, [...selectedForDelete])
      if (result.deleted.length > 0) {
        addToast({ type: 'success', message: `Deleted ${result.deleted.length} branch${result.deleted.length !== 1 ? 'es' : ''}`, duration: 3000 })
      }
      if (result.failed.length > 0) {
        addToast({ type: 'error', message: `Failed to delete: ${result.failed.map((f) => f.branch).join(', ')}`, duration: 0 })
      }
      setScanned(false)
      setMergedBranches([])
      setSelectedForDelete(new Set())
      const remaining = await findMergedAction(projectPath)
      setMergedBranches(remaining)
      setSelectedForDelete(new Set(remaining))
      setScanned(true)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Delete failed', duration: 0 })
    } finally {
      setDeleting(false)
    }
  }

  async function handleMerge() {
    if (!mergeSource) return
    setMerging(true)
    setMergeConflicts([])
    try {
      await mergeAction(projectPath, mergeSource)
      addToast({ type: 'success', message: `Merged ${mergeSource} into ${currentBranch}`, duration: 3000 })
      setMergeSource('')
      setOpen(false)
    } catch (err) {
      const conflicts = (err as { conflicts?: string[] }).conflicts
      if (conflicts && conflicts.length > 0) setMergeConflicts(conflicts)
      else reportGitError(err, 'Merge failed')
    } finally {
      setMerging(false)
    }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="flex items-center gap-1.5 px-3 py-2">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
          <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 1.942a2.25 2.25 0 1 1 0-3.884V4.5a.75.75 0 0 1-.75.75H9.5a.75.75 0 0 0-.75.75v.5c0 .414.336.75.75.75h2.25V7.5a.75.75 0 0 1-.75.75H5.5a2.25 2.25 0 0 1-2.25-2.25v-.5A2.25 2.25 0 0 1 5.5 3.25h4a2.25 2.25 0 0 1 2.25 2.25v.692a2.25 2.25 0 1 1-1.5 0V5.5A.75.75 0 0 0 9.5 4.75h-4A.75.75 0 0 0 4.75 5.5V6a.75.75 0 0 0 .75.75h5a2.25 2.25 0 0 1 2.25 2.25v.692zM4.25 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 1.942a2.25 2.25 0 1 1 0-3.884V9.75a.75.75 0 0 1 .75-.75h4a.75.75 0 0 0 .75-.75v-.5a.75.75 0 0 0-.75-.75H8.5v-.692a2.25 2.25 0 1 1 1.5 0V7.75A2.25 2.25 0 0 1 7.75 10H5.5a.75.75 0 0 0-.75.75v1.808a2.25 2.25 0 0 1 0 3.884z" />
        </svg>
        <span className="text-xs flex-1 truncate font-mono" style={{ color: 'var(--color-text)' }} title={currentBranch}>{currentBranch}</span>
        <button onClick={toggleOpen} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors flex items-center gap-1" style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', flexShrink: 0 }}>
          Branches
          <svg width="6" height="6" viewBox="0 0 8 8" fill="currentColor" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}><path d="M0 2l4 4 4-4z" /></svg>
        </button>
      </div>

      {open && (
        <div className="pb-2">
          <div className="px-3 mb-2">
            <button
              onClick={async () => {
                try {
                  await pullOriginAction(projectPath)
                  addToast({ type: 'success', message: 'Pulled from origin successfully', duration: 3000 })
                } catch (err) {
                  reportGitError(err, 'Pull from origin failed')
                }
              }}
              disabled={isPullingOrigin}
              className="w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
              title="Run git pull origin"
            >
              {isPullingOrigin ? 'Pulling…' : 'Pull Master'}
            </button>
          </div>

          <div className="flex px-3 gap-0 mb-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
            {(['switch', 'new', 'merge', 'clean'] as BranchMode[]).map((branchMode) => (
              <button
                key={branchMode}
                onClick={() => {
                  setMode(branchMode)
                  setSelectedBranch(null)
                  setBranchSearch('')
                  if (branchMode === 'clean' && !scanned && !scanning) void handleScan()
                }}
                className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors"
                style={{ color: mode === branchMode ? 'var(--color-text)' : 'var(--color-text-muted)', borderBottom: mode === branchMode ? '2px solid var(--color-claude)' : '2px solid transparent', marginBottom: -1 }}
              >
                {branchMode === 'switch' ? 'Switch' : branchMode === 'new' ? 'New' : branchMode === 'merge' ? 'Merge' : 'Clean'}
              </button>
            ))}
          </div>

          {mode === 'switch' && (
            <div className="px-3 space-y-2">
              <input
                type="text"
                value={branchSearch}
                onChange={(e) => {
                  setBranchSearch(e.target.value)
                  setSelectedBranch(null)
                }}
                placeholder="Search branches…"
                className="w-full rounded px-2 py-1.5 text-xs outline-none"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)', fontFamily: 'inherit' }}
              />
              {branchLoading ? (
                <p className="text-xs text-center py-2" style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
              ) : branches ? (
                <>
                  <div className="rounded overflow-y-auto space-y-0.5" style={{ maxHeight: 140, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
                    {filteredLocal.length > 0 && <>
                      <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Local</div>
                      {filteredLocal.map((branch) => (
                        <button key={branch} onClick={() => setSelectedBranch(branch === currentBranch ? null : branch)} disabled={branch === currentBranch} className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/5 disabled:opacity-40 transition-colors" style={{ background: selectedBranch === branch ? 'rgba(232,123,95,0.12)' : 'transparent', color: branch === currentBranch ? 'var(--color-claude)' : 'var(--color-text)' }}>
                          <span className="text-[10px] font-mono truncate flex-1">{branch}</span>
                          {branch === currentBranch && <span style={{ fontSize: '0.55rem', color: 'var(--color-claude)' }}>current</span>}
                        </button>
                      ))}
                    </>}
                    {filteredRemote.length > 0 && <>
                      <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Remote</div>
                      {filteredRemote.map((branch) => (
                        <button key={branch} onClick={() => setSelectedBranch(selectedBranch === branch ? null : branch)} className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/5 transition-colors" style={{ background: selectedBranch === branch ? 'rgba(232,123,95,0.12)' : 'transparent', color: 'var(--color-text)' }}>
                          <span className="text-[10px] font-mono truncate flex-1">{branch}</span>
                        </button>
                      ))}
                    </>}
                    {filteredLocal.length === 0 && filteredRemote.length === 0 && <p className="px-2 py-2 text-[10px] text-center" style={{ color: 'var(--color-text-muted)' }}>No branches match.</p>}
                  </div>

                  {selectedBranch && <div className="space-y-1.5">
                    {hasPendingChanges && <p className="text-[10px] rounded px-2 py-1" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>Warning: uncommitted changes may be lost.</p>}
                    {isRemoteSelected && <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={mergeFromMaster} onChange={(e) => setMergeFromMaster(e.target.checked)} className="rounded" style={{ accentColor: 'var(--color-claude)' }} />
                      <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Also merge from origin/master</span>
                    </label>}
                    <button onClick={() => void handleSwitch()} disabled={switching} className="w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }}>
                      {switching ? 'Checking out…' : `Checkout ${selectedBranch}`}
                    </button>
                  </div>}
                </>
              ) : <p className="text-xs text-center py-2" style={{ color: 'var(--color-text-muted)' }}>No branches found.</p>}
            </div>
          )}
          {mode === 'new' && (
            <div className="px-3 space-y-2">
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Branch name" onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }} className="w-full rounded px-2 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)', fontFamily: 'inherit' }} />
              <div className="space-y-1">
                <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Base branch</p>
                <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} className="w-full rounded px-2 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                  {branchLoading ? <option>Loading…</option> : allBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={pullFirst} onChange={(e) => setPullFirst(e.target.checked)} style={{ accentColor: 'var(--color-claude)' }} />
                <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Pull origin first (use latest remote)</span>
              </label>
              <button onClick={() => void handleCreate()} disabled={creating || !newName.trim() || !baseBranch} className="w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }}>
                {creating ? 'Creating…' : 'Create Branch'}
              </button>
            </div>
          )}
          {mode === 'merge' && (
            <div className="px-3 space-y-2">
              <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Merge into <span className="font-mono" style={{ color: 'var(--color-text)' }}>{currentBranch}</span></p>
              <input type="text" value={branchSearch} onChange={(e) => { setBranchSearch(e.target.value); setMergeSource(''); setMergeConflicts([]) }} placeholder="Search branches…" className="w-full rounded px-2 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)', fontFamily: 'inherit' }} />
              {branchLoading ? (
                <p className="text-xs text-center py-2" style={{ color: 'var(--color-text-muted)' }}>Loading…</p>
              ) : (
                <div className="rounded overflow-y-auto space-y-0.5" style={{ maxHeight: 120, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
                  {filteredAll.filter((branch) => branch !== currentBranch).length === 0 ? <p className="px-2 py-2 text-[10px] text-center" style={{ color: 'var(--color-text-muted)' }}>No branches match.</p> : filteredAll.filter((branch) => branch !== currentBranch).map((branch) => (
                    <button key={branch} onClick={() => { setMergeSource(mergeSource === branch ? '' : branch); setMergeConflicts([]) }} className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-white/5 transition-colors" style={{ background: mergeSource === branch ? 'rgba(232,123,95,0.12)' : 'transparent', color: 'var(--color-text)' }}>
                      <span className="text-[10px] font-mono truncate flex-1">{branch}</span>
                    </button>
                  ))}
                </div>
              )}
              {mergeConflicts.length > 0 && (
                <div className="rounded px-2 py-1.5 space-y-1" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)' }}>
                  <p className="text-[10px] font-semibold" style={{ color: '#f87171' }}>Conflicts in {mergeConflicts.length} file{mergeConflicts.length !== 1 ? 's' : ''} - resolve and commit:</p>
                  <ul className="space-y-0.5">{mergeConflicts.map((file) => <li key={file} className="text-[10px] font-mono truncate" style={{ color: '#fca5a5' }} title={file}>{file}</li>)}</ul>
                </div>
              )}
              <button onClick={() => void handleMerge()} disabled={merging || !mergeSource} className="w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }}>
                {merging ? 'Merging…' : mergeSource ? `Merge ${mergeSource}` : 'Merge'}
              </button>
            </div>
          )}
          {mode === 'clean' && (
            <div className="px-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Branches squash-merged into master</p>
                <button onClick={() => void handleScan()} disabled={scanning} className="rounded p-0.5 hover:bg-white/10 transition-colors disabled:opacity-40" style={{ color: 'var(--color-text-muted)' }} title="Re-scan">
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className={scanning ? 'animate-spin' : ''}>
                    <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" />
                    <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
                  </svg>
                </button>
              </div>
              {scanning && <p className="text-xs text-center py-3" style={{ color: 'var(--color-text-muted)' }}>Scanning… (fetching origin)</p>}
              {!scanning && scanned && mergedBranches.length === 0 && <p className="text-xs text-center py-3" style={{ color: 'var(--color-text-muted)' }}>No merged branches to clean up.</p>}
              {!scanning && scanned && mergedBranches.length > 0 && <>
                <div className="flex items-center justify-between mb-0.5">
                  <button onClick={() => setSelectedForDelete(new Set(mergedBranches))} className="text-[10px] hover:underline" style={{ color: 'var(--color-text-muted)' }}>Select all</button>
                  <button onClick={() => setSelectedForDelete(new Set())} className="text-[10px] hover:underline" style={{ color: 'var(--color-text-muted)' }}>Deselect all</button>
                </div>
                <div className="rounded overflow-y-auto space-y-0.5 py-1" style={{ maxHeight: 160, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
                  {mergedBranches.map((branch) => (
                    <label key={branch} className="flex items-center gap-2 px-2 py-1 hover:bg-white/5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedForDelete.has(branch)}
                        onChange={(e) => {
                          setSelectedForDelete((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(branch)
                            else next.delete(branch)
                            return next
                          })
                        }}
                        style={{ accentColor: 'var(--color-claude)', flexShrink: 0 }}
                      />
                      <span className="text-[10px] font-mono truncate" style={{ color: 'var(--color-text)' }}>{branch}</span>
                    </label>
                  ))}
                </div>
                <button onClick={() => void handleDeleteBranches()} disabled={deleting || selectedForDelete.size === 0} className="w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'rgba(248, 113, 113, 0.15)', color: '#f87171', border: '1px solid rgba(248, 113, 113, 0.3)' }}>
                  {deleting ? 'Deleting…' : selectedForDelete.size > 0 ? `Delete ${selectedForDelete.size} branch${selectedForDelete.size !== 1 ? 'es' : ''}` : 'Delete'}
                </button>
              </>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function GitSection({ threadId, collapsed, onToggle }: { threadId: string; collapsed: boolean; onToggle: () => void }) {
  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const allLocations = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const thread = Object.values(byProject).flat().find((t) => t.id === threadId) ?? Object.values(archivedByProject).flat().find((t) => t.id === threadId)
  const threadProjectId = thread?.project_id ?? null
  const locationsLoaded = threadProjectId ? allLocations[threadProjectId] !== undefined : false
  const threadLocations = threadProjectId ? (allLocations[threadProjectId] ?? EMPTY_LOCATIONS) : EMPTY_LOCATIONS
  const location = thread?.location_id ? threadLocations.find((entry) => entry.id === thread.location_id) : threadLocations[0] ?? null
  const projectPath = location?.path ?? null

  useEffect(() => {
    if (threadProjectId && !locationsLoaded) fetchLocations(threadProjectId)
  }, [threadProjectId, locationsLoaded, fetchLocations])

  const statusByPath = useGitStore((s) => s.statusByPath)
  const notRepoByPath = useGitStore((s) => s.notRepoByPath)
  const commitMessageByPath = useGitStore((s) => s.commitMessageByPath)
  const generatingMessageByPath = useGitStore((s) => s.generatingMessageByPath)
  const pushingByPath = useGitStore((s) => s.pushingByPath)
  const pullingByPath = useGitStore((s) => s.pullingByPath)
  const initializingByPath = useGitStore((s) => s.initializingByPath)
  const lastCommitByPath = useGitStore((s) => s.lastCommitByPath)
  const amendingByPath = useGitStore((s) => s.amendingByPath)
  const undoingCommitByPath = useGitStore((s) => s.undoingCommitByPath)
  const gitStatus = projectPath ? (statusByPath[projectPath] ?? null) : null
  const isNotRepo = projectPath ? (notRepoByPath[projectPath] ?? false) : false
  const isInitializing = projectPath ? (initializingByPath[projectPath] ?? false) : false
  const commitMsg = projectPath ? (commitMessageByPath[projectPath] ?? '') : ''
  const isGeneratingMessage = projectPath ? (generatingMessageByPath[projectPath] ?? false) : false
  const lastCommit = projectPath ? (lastCommitByPath[projectPath] ?? null) : null
  const isAmending = projectPath ? (amendingByPath[projectPath] ?? false) : false
  const isUndoingCommit = projectPath ? (undoingCommitByPath[projectPath] ?? false) : false
  const modifiedFiles = useGitStore((s) => s.modifiedFilesByThread[threadId] ?? EMPTY_FILES)
  const fetchGit = useGitStore((s) => s.fetch)
  const refreshRemoteGit = useGitStore((s) => s.refreshRemote)
  const initRepo = useGitStore((s) => s.initRepo)
  const commitGit = useGitStore((s) => s.commit)
  const amendCommitAction = useGitStore((s) => s.amendCommit)
  const undoLastCommitAction = useGitStore((s) => s.undoLastCommit)
  const setCommitMsg = useGitStore((s) => s.setCommitMessage)
  const generateMsg = useGitStore((s) => s.generateCommitMessage)
  const stageFile = useGitStore((s) => s.stage)
  const unstageFile = useGitStore((s) => s.unstage)
  const stageAllFiles = useGitStore((s) => s.stageAll)
  const unstageAllFiles = useGitStore((s) => s.unstageAll)
  const stageFilesAction = useGitStore((s) => s.stageFiles)
  const discardFileAction = useGitStore((s) => s.discardFile)
  const discardFilesAction = useGitStore((s) => s.discardFiles)
  const discardAllAction = useGitStore((s) => s.discardAll)
  const fetchModifiedFiles = useGitStore((s) => s.fetchModifiedFiles)
  const addToast = useToastStore((s) => s.add)
  const selectDiff = useFilesStore((s) => s.selectDiff)
  const selectCompareDiffToMain = useFilesStore((s) => s.selectCompareDiffToMain)
  const selectFile = useFilesStore((s) => s.selectFile)
  const pushGit = useGitStore((s) => s.push)
  const pullGit = useGitStore((s) => s.pull)
  const reportGitError = useGitErrorReporter(projectPath)
  const isPushing = projectPath ? (pushingByPath[projectPath] ?? false) : false
  const isPulling = projectPath ? (pullingByPath[projectPath] ?? false) : false
  const checkoutGit = useGitStore((s) => s.checkout)

  const [committing, setCommitting] = useState(false)
  const [amendMode, setAmendMode] = useState(false)
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; file: GitFileChange } | null>(null)
  const [openPrs, setOpenPrs] = useState<PullRequestItem[]>([])
  const [currentPr, setCurrentPr] = useState<PullRequestItem | null>(null)
  const [prProvider, setPrProvider] = useState<'azure' | 'github' | null>(null)
  const [loadingPrs, setLoadingPrs] = useState(false)
  const [prError, setPrError] = useState<string | null>(null)
  const [checkingOutPrId, setCheckingOutPrId] = useState<number | null>(null)
  const [showCreatePr, setShowCreatePr] = useState(false)
  const [createPrTarget, setCreatePrTarget] = useState('main')
  const [createPrTitle, setCreatePrTitle] = useState('')
  const [createPrDescription, setCreatePrDescription] = useState('')
  const [createPrTitleEdited, setCreatePrTitleEdited] = useState(false)
  const [creatingPr, setCreatingPr] = useState(false)
  const [returningToDefault, setReturningToDefault] = useState(false)
  const [prsCollapsed, setPrsCollapsed] = useState(false)
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [compareBaseRef, setCompareBaseRef] = useState('origin/main')
  const [compareFiles, setCompareFiles] = useState<GitFileChange[]>([])
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareLoadedBranch, setCompareLoadedBranch] = useState<string | null>(null)

  useEffect(() => {
    if (projectPath && !collapsed) fetchGit(projectPath)
  }, [projectPath, collapsed, fetchGit])

  useEffect(() => {
    if (threadId) fetchModifiedFiles(threadId)
  }, [threadId, fetchModifiedFiles])

  useEffect(() => {
    if (gitStatus && !createPrTitleEdited) setCreatePrTitle(`Merge ${gitStatus.branch} into ${createPrTarget}`)
  }, [gitStatus?.branch, createPrTarget, createPrTitleEdited])

  const refreshPullRequests = useCallback(async () => {
    if (!projectPath || !gitStatus || isNotRepo) return
    setLoadingPrs(true)
    setPrError(null)
    try {
      const [provider, resolvedDefaultBranch] = await Promise.all([
        window.api.invoke('git:hostingProvider', projectPath),
        window.api.invoke('git:defaultBranch', projectPath),
      ]) as ['azure' | 'github' | null, string]

      setDefaultBranch(resolvedDefaultBranch)

      if (provider === 'azure') {
        const [prs, current] = await Promise.all([window.api.invoke('azdo:pr:list', projectPath), window.api.invoke('azdo:pr:current', projectPath, gitStatus.branch)])
        setOpenPrs(prs as PullRequestItem[])
        setCurrentPr(current as PullRequestItem | null)
        setPrProvider('azure')
        setCreatePrTarget(resolvedDefaultBranch)
        return
      }

      if (provider === 'github') {
        const [prs, current] = await Promise.all([window.api.invoke('gh:pr:list', projectPath), window.api.invoke('gh:pr:current', projectPath, gitStatus.branch)])
        setOpenPrs(prs as PullRequestItem[])
        setCurrentPr(current as PullRequestItem | null)
        setPrProvider('github')
        setCreatePrTarget(resolvedDefaultBranch)
        return
      }

      setOpenPrs([])
      setCurrentPr(null)
      setPrProvider(null)
    } finally {
      setLoadingPrs(false)
    }
  }, [projectPath, gitStatus, isNotRepo])

  const refreshCompareToMain = useCallback(async () => {
    if (!projectPath || !gitStatus || isNotRepo) return
    const currentBranch = gitStatus.branch
    const showLoading = compareLoadedBranch !== currentBranch
    if (showLoading) setCompareLoading(true)
    try {
      const result = await window.api.invoke('git:compareToMain', projectPath) as GitCompareResult
      setCompareBaseRef(result.baseRef)
      setCompareFiles(result.files)
      setCompareLoadedBranch(currentBranch)
    } catch {
      if (showLoading) setCompareFiles([])
    } finally {
      if (showLoading) setCompareLoading(false)
    }
  }, [projectPath, gitStatus, isNotRepo, compareLoadedBranch])

  useEffect(() => {
    if (projectPath && !collapsed && gitStatus && !isNotRepo) void refreshPullRequests()
  }, [projectPath, collapsed, gitStatus, isNotRepo, refreshPullRequests])

  useEffect(() => {
    if (projectPath && !collapsed && gitStatus && !isNotRepo) void refreshCompareToMain()
  }, [projectPath, collapsed, gitStatus, isNotRepo, refreshCompareToMain])

  const handleSetCommitMsg = useCallback((msg: string) => {
    if (projectPath) setCommitMsg(projectPath, msg)
  }, [projectPath, setCommitMsg])

  const stagedFiles = gitStatus?.files.filter((file) => file.staged) ?? []
  const unstagedFiles = gitStatus?.files.filter((file) => !file.staged) ?? []
  const threadRelPaths = new Set(modifiedFiles.map((file) => projectPath ? file.replace(projectPath + '/', '').replace(projectPath + '\\', '') : file))
  const threadUnstagedFiles = unstagedFiles.filter((file) => threadRelPaths.has(file.path))
  const otherUnstagedFiles = unstagedFiles.filter((file) => !threadRelPaths.has(file.path))
  const showThreadSplit = threadUnstagedFiles.length > 0 && stagedFiles.length === 0

  const lastCommitIsPushed = !!(gitStatus?.hasUpstream && gitStatus.ahead === 0 && lastCommit)

  async function handleCommit() {
    if (!projectPath) return
    // In normal commit mode we require a message + changes to commit.
    if (!amendMode && (!commitMsg.trim() || (gitStatus?.files.length ?? 0) === 0)) return
    // In amend mode we allow commits with no staged changes (message-only fix)
    // but require at least a message or an unchanged last message to fall back to.
    if (amendMode && !commitMsg.trim() && !lastCommit) return

    if (amendMode && lastCommitIsPushed) {
      if (!window.confirm('Amend the last commit?\n\nThis commit has already been pushed to origin. Amending will rewrite history and you will need to force-push.')) return
    }

    setCommitting(true)
    try {
      if (amendMode) {
        // Stage changes when a message-change-only amend still has unstaged files.
        if (stagedFiles.length === 0 && unstagedFiles.length > 0) await stageAllFiles(projectPath)
        // If the message matches the existing one, pass null to use --no-edit and avoid a no-op rewrite.
        const trimmed = commitMsg.trim()
        const existing = lastCommit?.message.trim() ?? ''
        const msgToSend = trimmed && trimmed !== existing ? trimmed : null
        await amendCommitAction(projectPath, msgToSend)
        setAmendMode(false)
        addToast({ type: 'success', message: 'Amended last commit', duration: 3000 })
      } else {
        if (stagedFiles.length === 0) await stageAllFiles(projectPath)
        await commitGit(projectPath, commitMsg.trim())
        addToast({ type: 'success', message: 'Commit successful', duration: 3000 })
      }
    } catch (err) {
      reportGitError(err, 'Commit failed')
    } finally {
      setCommitting(false)
    }
  }

  const handleToggleAmend = useCallback(() => {
    if (!projectPath || !lastCommit) return
    setAmendMode((prev) => {
      const next = !prev
      if (next) {
        // Turning amend on — prefill the textarea with the last commit's message if empty.
        if (commitMsg.trim() === '') {
          setCommitMsg(projectPath, lastCommit.message)
        }
      } else {
        // Turning amend off — clear the textarea only if it still contains the exact prefilled message
        // (i.e. the user didn't edit it and hasn't typed their own message).
        if (commitMsg === lastCommit.message) {
          setCommitMsg(projectPath, '')
        }
      }
      return next
    })
  }, [projectPath, lastCommit, commitMsg, setCommitMsg])

  const handleUndoLastCommit = useCallback(async () => {
    if (!projectPath || !lastCommit || !lastCommit.hasParent) return
    const pushed = lastCommitIsPushed
    const warning = pushed
      ? `Undo the last commit "${lastCommit.subject}"?\n\nThis commit has already been pushed to origin. Undoing will rewrite history and you will need to force-push.\n\nChanges will be kept in the index (staged) so you can re-commit.`
      : `Undo the last commit "${lastCommit.subject}"?\n\nChanges will be kept in the index (staged) so you can re-commit.`
    if (!window.confirm(warning)) return
    try {
      await undoLastCommitAction(projectPath)
      addToast({ type: 'success', message: 'Undid last commit — changes are staged', duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to undo last commit')
    }
  }, [projectPath, lastCommit, lastCommitIsPushed, undoLastCommitAction, addToast, reportGitError])

  async function handleGenerateMessage() {
    if (!projectPath) return
    try {
      await generateMsg(projectPath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to generate message', duration: 0 })
    }
  }

  const handleStage = useCallback(async (filePath: string) => {
    if (!projectPath) return
    try { await stageFile(projectPath, filePath) } catch (err) { reportGitError(err, 'Failed to stage file', 3000) }
  }, [projectPath, stageFile, reportGitError])
  const handleUnstage = useCallback(async (filePath: string) => {
    if (!projectPath) return
    try { await unstageFile(projectPath, filePath) } catch (err) { reportGitError(err, 'Failed to unstage file', 3000) }
  }, [projectPath, unstageFile, reportGitError])
  const handleStageAll = useCallback(async () => {
    if (!projectPath) return
    try { await stageAllFiles(projectPath) } catch (err) { reportGitError(err, 'Failed to stage files', 3000) }
  }, [projectPath, stageAllFiles, reportGitError])
  const handleFileClick = useCallback((file: GitFileChange) => {
    if (projectPath) selectDiff(projectPath, file.path, file.staged)
  }, [projectPath, selectDiff])
  const handleCompareFileClick = useCallback((file: GitFileChange) => {
    if (projectPath) selectCompareDiffToMain(projectPath, file.path)
  }, [projectPath, selectCompareDiffToMain])
  const handleUnstageAll = useCallback(async () => {
    if (!projectPath) return
    try { await unstageAllFiles(projectPath) } catch (err) { reportGitError(err, 'Failed to unstage files', 3000) }
  }, [projectPath, unstageAllFiles, reportGitError])
  const handleStageThreadFiles = useCallback(async () => {
    if (!projectPath || threadUnstagedFiles.length === 0) return
    try { await stageFilesAction(projectPath, threadUnstagedFiles.map((file) => file.path)) } catch (err) { reportGitError(err, 'Failed to stage files', 3000) }
  }, [projectPath, threadUnstagedFiles, stageFilesAction, reportGitError])
  const handleStageOtherFiles = useCallback(async () => {
    if (!projectPath || otherUnstagedFiles.length === 0) return
    try { await stageFilesAction(projectPath, otherUnstagedFiles.map((file) => file.path)) } catch (err) { reportGitError(err, 'Failed to stage files', 3000) }
  }, [projectPath, otherUnstagedFiles, stageFilesAction, reportGitError])

  const handleDiscardFile = useCallback(async (file: GitFileChange) => {
    if (!projectPath) return
    const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
    const warning = file.status === '?' || file.status === 'A'
      ? `Permanently delete ${label}?\n\nThis cannot be undone.`
      : `Discard changes to ${label}?\n\nThis cannot be undone.`
    if (!window.confirm(warning)) return
    try {
      await discardFileAction(projectPath, { path: file.path, oldPath: file.oldPath })
      addToast({ type: 'success', message: `Discarded changes to ${basename(file.path)}`, duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to discard changes')
    }
  }, [projectPath, discardFileAction, addToast, reportGitError])

  const handleDiscardGroup = useCallback(async (groupLabel: string, files: GitFileChange[]) => {
    if (!projectPath || files.length === 0) return
    const n = files.length
    const warning = `Discard changes to ${n} file${n !== 1 ? 's' : ''} in "${groupLabel}"?\n\nThis cannot be undone. Any new (untracked) files in this group will be deleted from disk.`
    if (!window.confirm(warning)) return
    try {
      await discardFilesAction(projectPath, files.map((f) => ({ path: f.path, oldPath: f.oldPath })))
      addToast({ type: 'success', message: `Discarded ${n} file${n !== 1 ? 's' : ''}`, duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to discard changes')
    }
  }, [projectPath, discardFilesAction, addToast, reportGitError])

  const handleFileOpen = useCallback((file: GitFileChange) => {
    if (!projectPath) return
    // Deleted files don't exist on disk — fall back to opening the diff so the user sees *something*.
    if (file.status === 'D') {
      selectDiff(projectPath, file.path, file.staged)
      return
    }
    const fullPath = joinRepoPath(projectPath, file.path)
    selectFile(fullPath)
  }, [projectPath, selectFile, selectDiff])

  const handleRevealInExplorer = useCallback(async (file: GitFileChange) => {
    if (!projectPath) return
    try {
      const fullPath = joinRepoPath(projectPath, file.path)
      await window.api.invoke('shell:revealInExplorer', fullPath)
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to reveal in Explorer', duration: 3000 })
    }
  }, [projectPath, addToast])

  const handleCopyPath = useCallback(async (file: GitFileChange, relative: boolean) => {
    if (!projectPath) return
    try {
      const value = relative ? file.path : joinRepoPath(projectPath, file.path)
      await window.api.invoke('shell:copyPath', value)
      addToast({ type: 'success', message: relative ? 'Copied relative path' : 'Copied path', duration: 2000 })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to copy path', duration: 3000 })
    }
  }, [projectPath, addToast])

  const handleFileContextMenu = useCallback((file: GitFileChange, event: React.MouseEvent) => {
    setFileMenu({ x: event.clientX, y: event.clientY, file })
  }, [])

  const handleDiscardAll = useCallback(async () => {
    if (!projectPath || !gitStatus || gitStatus.files.length === 0) return
    const n = gitStatus.files.length
    const warning = `Discard ALL local changes?\n\nThis will revert every tracked file and delete every untracked file (${n} total). This cannot be undone.`
    if (!window.confirm(warning)) return
    try {
      await discardAllAction(projectPath)
      addToast({ type: 'success', message: 'Discarded all local changes', duration: 3000 })
    } catch (err) {
      reportGitError(err, 'Failed to discard all changes')
    }
  }, [projectPath, gitStatus, discardAllAction, addToast, reportGitError])

  const totalChanges = gitStatus?.files.length ?? 0
  const otherOpenPrs = currentPr ? openPrs.filter((pr) => pr.id !== currentPr.id) : openPrs
  const refreshButton = (
    <button
      onClick={() => {
        if (!projectPath) return
        void refreshRemoteGit(projectPath)
        void refreshPullRequests()
        void refreshCompareToMain()
      }}
      className="rounded p-1 hover:bg-white/10 transition-colors mr-1"
      style={{ color: 'var(--color-text-muted)' }}
      title="Refresh"
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" /><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" /></svg>
    </button>
  )

  async function handleCheckoutPr(prId: number) {
    if (!projectPath || !prProvider) return
    setCheckingOutPrId(prId)
    try {
      const result = prProvider === 'azure' ? await window.api.invoke('azdo:pr:checkout', projectPath, prId) : await window.api.invoke('gh:pr:checkout', projectPath, prId)
      await fetchGit(projectPath)
      await refreshPullRequests()
      addToast({ type: 'success', message: `Checked out ${String((result as { branch: string }).branch)}`, duration: 3000 })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to checkout PR branch', duration: 0 })
    } finally {
      setCheckingOutPrId(null)
    }
  }

  async function handleCreatePr() {
    if (!projectPath || !createPrTitle.trim() || !createPrTarget.trim() || !prProvider) return
    setCreatingPr(true)
    try {
      const payload = { target: createPrTarget.trim(), title: createPrTitle.trim(), description: createPrDescription.trim() || undefined }
      const pr = prProvider === 'azure' ? await window.api.invoke('azdo:pr:create', projectPath, payload) : await window.api.invoke('gh:pr:create', projectPath, payload)
      addToast({ type: 'success', message: `Created PR #${String((pr as PullRequestItem).id)}`, duration: 3000 })
      setShowCreatePr(false)
      setCreatePrDescription('')
      setCreatePrTitleEdited(false)
      await refreshPullRequests()
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to create pull request', duration: 0 })
    } finally {
      setCreatingPr(false)
    }
  }

  async function handleReturnToDefaultBranch() {
    if (!projectPath || !defaultBranch) return
    setReturningToDefault(true)
    try {
      await checkoutGit(projectPath, defaultBranch)
      await pullGit(projectPath)
      await refreshPullRequests()
      addToast({ type: 'success', message: `Switched to ${defaultBranch} and pulled latest changes`, duration: 3000 })
    } catch (err) {
      addToast({ type: 'error', message: err instanceof Error ? err.message : `Failed to return to ${defaultBranch}`, duration: 0 })
    } finally {
      setReturningToDefault(false)
    }
  }

  const hasPendingChanges = unstagedFiles.length > 0
  const showReturnToDefault = !!gitStatus && defaultBranch.trim().length > 0 && gitStatus.branch !== defaultBranch
  const returnToDefaultLabel =
    defaultBranch === 'master' ? 'Return to master'
    : defaultBranch === 'main' ? 'Return to main'
    : `Return to ${defaultBranch}`

  return (
    <div className="flex-shrink-0">
      <SectionHeader label="Source Control" collapsed={collapsed} onToggle={onToggle} badge={totalChanges > 0 ? String(totalChanges) : undefined} right={refreshButton} />
      {!collapsed && <>
        {projectPath && gitStatus && !isNotRepo && <BranchControls projectPath={projectPath} currentBranch={gitStatus.branch} hasPendingChanges={hasPendingChanges} />}
        {projectPath && gitStatus && !isNotRepo && <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setPrsCollapsed((value) => !value)} className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-white/10 transition-colors" style={{ color: 'var(--color-text-muted)' }} title={prsCollapsed ? 'Expand pull requests' : 'Collapse pull requests'}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ transform: prsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', opacity: 0.7 }}><path d="M0 2l4 4 4-4z" /></svg>
              <span className="text-[11px] font-semibold whitespace-nowrap">Pull Requests {prProvider ? `(${prProvider === 'azure' ? 'Azure DevOps' : 'GitHub'})` : ''}</span>
            </button>
            <button onClick={() => void refreshPullRequests()} disabled={loadingPrs} className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 transition-colors disabled:opacity-40" style={{ color: 'var(--color-text-muted)' }} title="Refresh pull requests">{loadingPrs ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          {!prsCollapsed && (prError ? <p className="text-[11px] leading-relaxed" style={{ color: '#f87171' }}>{prError}</p> : <>
            <div className="mb-2 rounded px-2 py-1.5" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
              <p className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-muted)', opacity: 0.8 }}>Current PR</p>
              {currentPr ? <div className="mt-1"><p className="text-xs truncate" style={{ color: 'var(--color-text)' }}>{currentPr.url ? <a href={currentPr.url} className="hover:underline" style={{ color: 'var(--color-claude)' }}>#{currentPr.id}</a> : `#${currentPr.id}`} {currentPr.title}</p><p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{currentPr.sourceBranch} → {currentPr.targetBranch}</p></div> : <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>No open PR for <code>{gitStatus.branch}</code>.</p>}
            </div>
            <div className="space-y-1 mb-2">{otherOpenPrs.length === 0 ? <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No open pull requests.</p> : otherOpenPrs.map((pr) => <div key={pr.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}><div className="min-w-0"><p className="text-xs truncate" style={{ color: 'var(--color-text)' }}>{pr.url ? <a href={pr.url} className="hover:underline" style={{ color: 'var(--color-claude)' }}>#{pr.id}</a> : `#${pr.id}`} {pr.title}</p><p className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>{pr.sourceBranch} → {pr.targetBranch}</p></div><button onClick={() => void handleCheckoutPr(pr.id)} disabled={checkingOutPrId === pr.id} className="rounded px-2 py-1 text-[10px] font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }} title={`Checkout PR #${pr.id}`}>{checkingOutPrId === pr.id ? 'Checking…' : 'Checkout'}</button></div>)}</div>
            {!showCreatePr ? <button onClick={() => { setCreatePrTitleEdited(false); setShowCreatePr(true) }} disabled={!prProvider} className="w-full rounded py-1.5 text-xs font-medium" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>Create PR</button> : <div className="space-y-1.5"><input value={createPrTarget} onChange={(e) => setCreatePrTarget(e.target.value)} placeholder="Target branch (e.g. main)" className="w-full rounded px-2 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} /><input value={createPrTitle} onChange={(e) => { setCreatePrTitle(e.target.value); setCreatePrTitleEdited(true) }} placeholder="PR title" className="w-full rounded px-2 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} /><textarea value={createPrDescription} onChange={(e) => setCreatePrDescription(e.target.value)} placeholder="Description (optional)" rows={3} className="w-full resize-none rounded px-2 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} /><div className="flex gap-1.5"><button onClick={() => void handleCreatePr()} disabled={creatingPr || !createPrTitle.trim() || !createPrTarget.trim()} className="flex-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }}>{creatingPr ? 'Creating…' : 'Create'}</button><button onClick={() => { setShowCreatePr(false); setCreatePrTitleEdited(false) }} disabled={creatingPr} className="flex-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>Cancel</button></div></div>}
            {showReturnToDefault && <button onClick={() => void handleReturnToDefaultBranch()} disabled={returningToDefault || hasPendingChanges} className="mt-1.5 w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} title={hasPendingChanges ? `Commit or stash unstaged changes before switching to ${defaultBranch}` : `Checkout ${defaultBranch} and pull latest changes`}>{returningToDefault ? 'Returning…' : returnToDefaultLabel}</button>}
          </>)}
        </div>}
        <div className="px-3 pt-2.5 pb-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
          {isNotRepo ? <div className="py-3 flex flex-col items-center gap-2"><p className="text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>No Git repository found.</p><button onClick={async () => { if (!projectPath) return; try { await initRepo(projectPath); addToast({ type: 'success', message: 'Git repository initialised', duration: 3000 }) } catch (err) { addToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to initialise repository', duration: 0 }) } }} disabled={isInitializing || !projectPath} className="rounded px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }}>{isInitializing ? 'Initialising…' : 'Initialise Repository'}</button></div> : !gitStatus ? <p className="py-2 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>{!thread ? 'Thread not loaded.' : !locationsLoaded ? 'Loading...' : !projectPath ? 'No location for project.' : 'Loading...'}</p> : <>
            <div className="relative">
              <textarea value={commitMsg} onChange={(e) => handleSetCommitMsg(e.target.value)} placeholder={amendMode ? 'Leave unchanged to keep the existing commit message' : 'Commit message (Ctrl+Enter)'} rows={2} onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); void handleCommit() } }} className="w-full resize-none rounded px-2 py-1.5 pr-7 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: amendMode ? '1px solid var(--color-claude)' : '1px solid var(--color-border)', color: 'var(--color-text)', fontFamily: 'inherit' }} />
              <button onClick={() => void handleGenerateMessage()} disabled={isGeneratingMessage || totalChanges === 0} className="absolute right-1 top-1 rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40" style={{ color: 'var(--color-claude)' }} title="Generate commit message with AI">{isGeneratingMessage ? <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="animate-spin"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" /></svg> : <SparkleIcon />}</button>
            </div>
            {lastCommit && <div className="mt-1.5 flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer min-w-0 flex-1" title={lastCommit.message}>
                <input type="checkbox" checked={amendMode} onChange={handleToggleAmend} style={{ accentColor: 'var(--color-claude)', flexShrink: 0 }} />
                <span className="text-[10px] truncate" style={{ color: amendMode ? 'var(--color-claude)' : 'var(--color-text-muted)' }}>
                  Amend: <span className="font-mono">{lastCommit.subject}</span>
                </span>
              </label>
              {lastCommit.hasParent && <button onClick={() => void handleUndoLastCommit()} disabled={isUndoingCommit} className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 transition-colors disabled:opacity-40" style={{ color: 'var(--color-text-muted)' }} title={`Undo last commit (git reset --soft HEAD~1)${lastCommitIsPushed ? ' — WARNING: already pushed' : ''}`}>
                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3a5 5 0 1 1-4.546 7.914.75.75 0 1 0-1.294.76 6.5 6.5 0 1 0-.16-6.164l-.854-.854a.5.5 0 0 0-.854.354v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .354-.854l-.89-.89A4.99 4.99 0 0 1 8 3z" /></svg>
                {isUndoingCommit ? 'Undoing…' : 'Undo'}
              </button>}
            </div>}
            <button onClick={() => void handleCommit()} disabled={committing || isAmending || (amendMode ? (!commitMsg.trim() && totalChanges === 0) : (!commitMsg.trim() || totalChanges === 0))} className="mt-1.5 w-full rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--color-claude)', color: '#fff' }}>{committing || isAmending ? (amendMode ? 'Amending…' : 'Committing…') : amendMode ? `Amend${totalChanges > 0 ? ` (${totalChanges})` : ''}` : 'Commit'}</button>
            <div className="flex gap-1.5 mt-1.5">
              <button
                onClick={async () => {
                  if (!projectPath) return
                  try {
                    const result = await pullGit(projectPath, true) as PullResult | void
                    if (result && typeof result === 'object' && 'popConflict' in result && result.popConflict) {
                      addToast({ type: 'error', message: `Pulled but could not re-apply auto-stash (${result.stashRef}) — resolve conflicts manually`, duration: 0 })
                    } else if (result && typeof result === 'object' && 'stashed' in result && result.stashed) {
                      addToast({ type: 'success', message: 'Pulled (auto-stashed & restored local changes)', duration: 3000 })
                    } else {
                      addToast({ type: 'success', message: 'Pulled successfully', duration: 3000 })
                    }
                  } catch (err) {
                    reportGitError(err, 'Pull failed')
                  }
                }}
                disabled={isPulling}
                className="flex-1 flex items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: gitStatus.behind > 0 ? '#f87171' : 'var(--color-text-muted)' }}
                title="Pull from remote (auto-stashes local changes if the tree is dirty)"
              >
                {isPulling ? <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" /></svg> : <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12l-4-4h2.5V4h3v4H12L8 12z" /></svg>}
                Pull{gitStatus.behind > 0 ? ` ↓${gitStatus.behind}` : ''}
              </button>
              <button onClick={async () => { if (!projectPath) return; try { await pushGit(projectPath); addToast({ type: 'success', message: !gitStatus.hasUpstream ? `Published branch "${gitStatus.branch}"` : 'Pushed successfully', duration: 3000 }) } catch (err) { reportGitError(err, 'Push failed') } }} disabled={isPushing} className="flex-1 flex items-center justify-center gap-1 rounded py-1.5 text-xs font-medium transition-opacity disabled:opacity-40" style={{ background: !gitStatus.hasUpstream ? 'rgba(232, 123, 95, 0.12)' : 'var(--color-surface-2)', border: !gitStatus.hasUpstream ? '1px solid rgba(232, 123, 95, 0.4)' : '1px solid var(--color-border)', color: !gitStatus.hasUpstream ? 'var(--color-claude)' : gitStatus.ahead > 0 ? '#4ade80' : 'var(--color-text-muted)' }} title={!gitStatus.hasUpstream ? `Publish branch "${gitStatus.branch}" to origin (--force-with-lease)` : 'Push to remote (--force-with-lease, safe after amend/rebase)'}>{isPushing ? <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="animate-spin"><path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" /></svg> : <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4l4 4H9.5v4h-3V8H4l4-4z" /></svg>}{isPushing ? (!gitStatus.hasUpstream ? 'Publishing…' : 'Pushing…') : !gitStatus.hasUpstream ? 'Publish' : `Push${gitStatus.ahead > 0 ? ` ↑${gitStatus.ahead}` : ''}`}</button>
            </div>
          </>}
        </div>
        {projectPath && gitStatus && !isNotRepo && <StashSection projectPath={projectPath} />}
        {projectPath && gitStatus && !isNotRepo && <CommitLogSection projectPath={projectPath} range="HEAD" label="Commit Log" topBorder />}
        {gitStatus && <div className="py-1">
          {totalChanges === 0 ? <p className="px-4 py-4 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>No local changes.</p> : <>
            {stagedFiles.length > 0 && <FileGroup label="Staged" files={stagedFiles} onFileAction={handleUnstage} onGroupAction={handleUnstageAll} actionIcon="minus" actionTitle="Unstage" onFileClick={handleFileClick} onFileDiscard={handleDiscardFile} onGroupDiscard={() => void handleDiscardGroup('Staged', stagedFiles)} onFileContextMenu={handleFileContextMenu} />}
            {showThreadSplit ? <>
              <FileGroup label="From this thread" files={threadUnstagedFiles} onFileAction={handleStage} onGroupAction={handleStageThreadFiles} actionIcon="plus" actionTitle="Stage" onFileClick={handleFileClick} onFileDiscard={handleDiscardFile} onGroupDiscard={() => void handleDiscardGroup('From this thread', threadUnstagedFiles)} onFileContextMenu={handleFileContextMenu} />
              {otherUnstagedFiles.length > 0 && <FileGroup label="Other changes" files={otherUnstagedFiles} onFileAction={handleStage} onGroupAction={handleStageOtherFiles} actionIcon="plus" actionTitle="Stage" onFileClick={handleFileClick} onFileDiscard={handleDiscardFile} onGroupDiscard={() => void handleDiscardGroup('Other changes', otherUnstagedFiles)} onFileContextMenu={handleFileContextMenu} />}
            </> : unstagedFiles.length > 0 && <FileGroup label="Changes" files={unstagedFiles} onFileAction={handleStage} onGroupAction={handleStageAll} actionIcon="plus" actionTitle="Stage" onFileClick={handleFileClick} onFileDiscard={handleDiscardFile} onGroupDiscard={() => void handleDiscardGroup('Changes', unstagedFiles)} onFileContextMenu={handleFileContextMenu} />}
            <div className="mt-1 px-3 pt-1.5">
              <button
                onClick={() => void handleDiscardAll()}
                className="w-full flex items-center justify-center gap-1.5 rounded py-1.5 text-[11px] font-medium transition-colors"
                style={{ background: 'transparent', border: '1px solid rgba(248, 113, 113, 0.3)', color: '#f87171' }}
                title="Revert every tracked file to HEAD and delete untracked files"
              >
                <DiscardIcon />
                Discard All Changes ({totalChanges})
              </button>
            </div>
          </>}
          <div className="mt-1 pt-1" style={{ borderTop: '1px solid var(--color-border)' }}>
            <div className="px-3 pb-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Compare base: <code>{compareBaseRef}</code></div>
            {compareLoading ? <p className="px-4 py-2 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>Loading compare…</p> : compareFiles.length === 0 ? <p className="px-4 py-2 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>No changes vs {compareBaseRef}.</p> : <FileGroup label="Compare to Master" files={compareFiles} showActions={false} onFileClick={handleCompareFileClick} onFileContextMenu={handleFileContextMenu} />}
            {projectPath && <CommitLogSection projectPath={projectPath} range={`${compareBaseRef}..HEAD`} label="Commits vs Base" refreshKey={compareBaseRef} topBorder />}
          </div>
        </div>}
      </>}
      {fileMenu && (() => {
        const { file } = fileMenu
        const isDeleted = file.status === 'D'
        const isSsh = location?.connection_type === 'ssh'
        const items: ContextMenuItem[] = [
          {
            id: 'open-file',
            label: 'Open File',
            title: isDeleted ? 'File has been deleted — opens the diff instead' : 'View the current contents of this file',
            onSelect: () => handleFileOpen(file),
          },
          {
            id: 'open-diff',
            label: 'Open Diff',
            title: 'Show the diff for this file',
            onSelect: () => { if (projectPath) selectDiff(projectPath, file.path, file.staged) },
          },
          {
            id: 'reveal',
            label: 'Reveal in Explorer',
            separator: true,
            disabled: isSsh,
            title: isSsh ? 'Not available for SSH-hosted repos' : 'Show this file in the system file manager',
            onSelect: () => handleRevealInExplorer(file),
          },
          {
            id: 'copy-path',
            label: 'Copy Path',
            separator: true,
            onSelect: () => handleCopyPath(file, false),
          },
          {
            id: 'copy-rel-path',
            label: 'Copy Relative Path',
            onSelect: () => handleCopyPath(file, true),
          },
        ]
        return <ContextMenu x={fileMenu.x} y={fileMenu.y} items={items} onClose={() => setFileMenu(null)} />
      })()}
    </div>
  )
}
