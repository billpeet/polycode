import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { useBackdropClose } from '../../hooks/useBackdropClose'
import { useToastStore } from '../../stores/toast'
import { useGitStore } from '../../stores/git'
import { formatErrorDetails } from '../../lib/errorDetails'
import { GitBranches, GitFileChange } from '../../types/ipc'
import MarkdownEditor from '../MarkdownEditor'
import { SparkleIcon } from './shared'

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

interface Props {
  projectPath: string
  sourceBranch: string
  provider: 'azure' | 'github'
  defaultTarget: string
  onClose: () => void
  /** Called after a PR is successfully created (e.g. to refresh the PR list). */
  onCreated: () => void
}

/** A single file's section of a combined unified diff. */
interface DiffFile {
  path: string
  patch: string
}

/** Split a combined `git diff` output into per-file patches with their paths. */
function splitDiffByFile(diff: string): DiffFile[] {
  if (!diff.trim()) return []
  const lines = diff.split('\n')
  const files: DiffFile[] = []
  let current: string[] = []

  const flush = () => {
    if (current.length === 0) return
    const header = current[0]
    const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/)
    const path = match ? match[2] : 'changes'
    files.push({ path, patch: current.join('\n') })
    current = []
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) flush()
    current.push(line)
  }
  flush()
  return files
}

function basename(p: string): string {
  return p.split('/').pop() || p
}

function dirname(p: string): string {
  const parts = p.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

function Spinner({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className="animate-spin">
      <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z" />
    </svg>
  )
}

function statusColor(status: GitFileChange['status']): string {
  switch (status) {
    case 'A': return '#4ade80'
    case 'M': return '#e2c08d'
    case 'D': return '#f87171'
    case 'R': return '#a78bfa'
    case 'U': return '#f87171'
    default: return 'var(--color-text-muted)'
  }
}

const EMPTY_FILES: GitFileChange[] = []

export default function CreatePrModal({ projectPath, sourceBranch, provider, defaultTarget, onClose, onCreated }: Props) {
  const backdropClose = useBackdropClose(onClose)
  const addToast = useToastStore((s) => s.add)

  // Live git status (for uncommitted changes, ahead/upstream). GitSection keeps this fresh,
  // but we also refresh on mount so the modal reflects the latest working tree.
  const gitStatus = useGitStore((s) => s.statusByPath[projectPath] ?? null)
  const fetchGit = useGitStore((s) => s.fetch)

  const [target, setTarget] = useState(defaultTarget)
  const [title, setTitle] = useState('')
  const [titleEdited, setTitleEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [creating, setCreating] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatingCommit, setGeneratingCommit] = useState(false)
  const [generatingBranch, setGeneratingBranch] = useState(false)

  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffReqId = useRef(0)

  // Refs for the diff scroll area + per-file sections, so the sidebar can scroll to a file.
  const diffScrollRef = useRef<HTMLDivElement | null>(null)
  const fileRefs = useRef<Array<HTMLDivElement | null>>([])
  const [activeFile, setActiveFile] = useState(0)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())

  function toggleCollapsed(path: string) {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const uncommittedFiles = gitStatus?.files ?? EMPTY_FILES
  const dirty = uncommittedFiles.length > 0
  const ahead = gitStatus?.ahead ?? 0
  const hasUpstream = gitStatus?.hasUpstream ?? false
  // You can't open a PR directly from the default branch — committing there is blocked and
  // the PR would have no distinct source. When on it, we create a new branch first.
  const onDefaultBranch = sourceBranch === defaultTarget
  const effectiveSource = onDefaultBranch ? (newBranchName.trim() || 'new-branch') : sourceBranch

  useEffect(() => {
    void fetchGit(projectPath)
  }, [projectPath, fetchGit])

  // Default title tracks "Merge <source> into <target>" until the user edits it.
  useEffect(() => {
    if (!titleEdited) setTitle(`Merge ${effectiveSource} into ${target}`)
  }, [effectiveSource, target, titleEdited])

  // Load the branch list for the target dropdown.
  useEffect(() => {
    let cancelled = false
    void window.api.invoke('git:branches', projectPath).then((result) => {
      if (!cancelled) setBranches(result)
    }).catch(() => { /* leave dropdown with just the default target */ })
    return () => { cancelled = true }
  }, [projectPath])

  // Load the diff between the current branch (including uncommitted tracked changes) and the
  // selected target. `git diff <merge-base>` includes the working tree, so this previews what
  // the PR will contain once changes are committed.
  const loadDiff = useCallback(async () => {
    if (!target.trim()) return
    const reqId = ++diffReqId.current
    setDiffLoading(true)
    try {
      const result = await window.api.invoke('git:compareDiffToBranch', projectPath, target.trim())
      if (diffReqId.current === reqId) setDiff(result)
    } catch {
      if (diffReqId.current === reqId) setDiff('')
    } finally {
      if (diffReqId.current === reqId) setDiffLoading(false)
    }
  }, [projectPath, target])

  useEffect(() => {
    void loadDiff()
  }, [loadDiff])

  // Close on Escape.
  const busy = creating || generating || generatingCommit || generatingBranch
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const diffFiles = useMemo(() => splitDiffByFile(diff ?? ''), [diff])
  const allCollapsed = diffFiles.length > 0 && diffFiles.every((f) => collapsedFiles.has(f.path))

  // Reset scroll position/selection when the comparison reloads (e.g. target changed).
  useEffect(() => {
    setActiveFile(0)
    setCollapsedFiles(new Set())
    if (diffScrollRef.current) diffScrollRef.current.scrollTop = 0
  }, [diff])

  function scrollToFile(index: number) {
    setActiveFile(index)
    fileRefs.current[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  // Highlight the file whose section is currently at the top of the scroll area.
  function handleDiffScroll() {
    const container = diffScrollRef.current
    if (!container) return
    const containerTop = container.getBoundingClientRect().top
    let idx = 0
    for (let i = 0; i < diffFiles.length; i++) {
      const el = fileRefs.current[i]
      if (!el) continue
      if (el.getBoundingClientRect().top - containerTop <= 12) idx = i
      else break
    }
    setActiveFile(idx)
  }

  const branchOptions = useMemo(() => {
    const set = new Set<string>()
    if (defaultTarget) set.add(defaultTarget)
    branches?.local.forEach((b) => set.add(b))
    branches?.remote.forEach((b) => set.add(b.replace(/^origin\//, '')))
    set.delete('HEAD')
    // You can't merge a branch into itself — but keep the default branch listed even when it's
    // the current branch, since on the default branch we create a new source branch anyway.
    if (sourceBranch !== defaultTarget) set.delete(sourceBranch)
    return [...set]
  }, [branches, defaultTarget, sourceBranch])

  // Keep the selected target valid so the <select> never displays a branch that isn't `target`.
  useEffect(() => {
    if (branchOptions.length === 0) return
    if (!branchOptions.includes(target)) {
      setTarget(branchOptions.includes(defaultTarget) ? defaultTarget : branchOptions[0])
    }
  }, [branchOptions, target, defaultTarget])

  async function handleGenerate() {
    if (!target.trim()) return
    const startingTitle = title
    const startingDescription = description
    setGenerating(true)
    try {
      const generated = await window.api.invoke('git:generatePullRequestText', projectPath, target.trim())
      if (!generated.title.trim() && !generated.description.trim()) {
        addToast({
          type: 'error',
          title: 'Generate PR Text Failed',
          message: 'No branch changes to describe for this PR',
          details: formatErrorDetails({ action: 'git:generatePullRequestText', projectPath, target: target.trim(), reason: 'empty generated title and description' }),
          duration: 3000,
        })
        return
      }
      if (generated.title.trim()) {
        setTitle((current) => (current === startingTitle ? generated.title : current))
        setTitleEdited(true)
      }
      if (generated.description.trim()) {
        setDescription((current) => (current === startingDescription ? generated.description : current))
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Generate PR Text Failed',
        message: err instanceof Error ? err.message : 'Failed to generate pull request text',
        details: formatErrorDetails({ action: 'git:generatePullRequestText', projectPath, target: target.trim() }, err),
        duration: 0,
      })
    } finally {
      setGenerating(false)
    }
  }

  async function handleGenerateCommitMessage() {
    const startingMessage = commitMessage
    setGeneratingCommit(true)
    try {
      const message = await window.api.invoke('git:generateCommitMessage', projectPath)
      if (message.trim()) {
        setCommitMessage((current) => (current === startingMessage ? message : current))
      } else {
        addToast({
          type: 'error',
          title: 'Generate Commit Message Failed',
          message: 'No staged or working changes to describe',
          details: formatErrorDetails({ action: 'git:generateCommitMessage', projectPath, reason: 'empty generated message' }),
          duration: 3000,
        })
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Generate Commit Message Failed',
        message: err instanceof Error ? err.message : 'Failed to generate commit message',
        details: formatErrorDetails({ action: 'git:generateCommitMessage', projectPath }, err),
        duration: 0,
      })
    } finally {
      setGeneratingCommit(false)
    }
  }

  async function handleGenerateBranchName() {
    const startingName = newBranchName
    setGeneratingBranch(true)
    try {
      const name = await window.api.invoke('git:generateBranchName', projectPath)
      if (name.trim()) {
        setNewBranchName((current) => (current === startingName ? name : current))
      } else {
        addToast({
          type: 'error',
          title: 'Generate Branch Name Failed',
          message: 'No changes to base a branch name on',
          details: formatErrorDetails({ action: 'git:generateBranchName', projectPath, reason: 'empty generated branch name' }),
          duration: 3000,
        })
      }
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Generate Branch Name Failed',
        message: err instanceof Error ? err.message : 'Failed to generate branch name',
        details: formatErrorDetails({ action: 'git:generateBranchName', projectPath }, err),
        duration: 0,
      })
    } finally {
      setGeneratingBranch(false)
    }
  }

  // Run every applicable AI generation at once, in parallel. Each sub-handler manages its own
  // loading flag + toast, so the per-field spinners light up independently.
  async function handleGenerateAll() {
    const tasks: Array<Promise<unknown>> = [handleGenerate()]
    if (dirty) tasks.push(handleGenerateCommitMessage())
    if (onDefaultBranch) tasks.push(handleGenerateBranchName())
    await Promise.allSettled(tasks)
  }

  async function handleCreate() {
    if (!canCreate) return
    setCreating(true)
    let step = 'start'
    try {
      // 1. On the default branch, branch off first so changes land on a feature branch.
      //    `git checkout -b <new> <source>` carries the uncommitted working tree along.
      if (onDefaultBranch) {
        step = 'git:createBranch'
        await window.api.invoke('git:createBranch', projectPath, newBranchName.trim(), sourceBranch, false)
      }
      // 2. Stage + commit any uncommitted changes so they're part of the PR.
      if (dirty) {
        step = 'git:stageAll'
        await window.api.invoke('git:stageAll', projectPath)
        step = 'git:commit'
        await window.api.invoke('git:commit', projectPath, commitMessage.trim())
      }
      // 3. Push so the source branch (and its commits) exist on the remote.
      if (onDefaultBranch || dirty || ahead > 0 || !hasUpstream) {
        step = 'git:push'
        await window.api.invoke('git:push', projectPath)
      }
      // 4. Create the PR (uses the now-current branch as the source).
      step = provider === 'azure' ? 'azdo:pr:create' : 'gh:pr:create'
      const payload = { target: target.trim(), title: title.trim(), description: description.trim() || undefined }
      const pr = provider === 'azure'
        ? await window.api.invoke('azdo:pr:create', projectPath, payload)
        : await window.api.invoke('gh:pr:create', projectPath, payload)
      addToast({ type: 'success', message: `Created PR #${String((pr as PullRequestItem).id)}`, duration: 3000 })
      await fetchGit(projectPath)
      onCreated()
      onClose()
    } catch (err) {
      addToast({
        type: 'error',
        title: 'Create Pull Request Failed',
        message: err instanceof Error ? err.message : 'Failed to create pull request',
        details: formatErrorDetails({
          action: step,
          projectPath,
          provider,
          source: effectiveSource,
          target: target.trim(),
          title: title.trim(),
          newBranch: onDefaultBranch ? newBranchName.trim() : undefined,
          committed: dirty,
        }, err),
        duration: 0,
      })
    } finally {
      setCreating(false)
    }
  }

  const inputStyle: React.CSSProperties = { background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }
  const anyGenerating = generating || generatingCommit || generatingBranch

  // There's something to PR when the branch has commits/changes over the target, or there are
  // uncommitted changes we'd commit first. `diff === null` means the comparison is still loading.
  const changesLoaded = diff !== null
  const hasWork = dirty || diffFiles.length > 0 || ahead > 0
  const nothingToDo = changesLoaded && !diffLoading && !hasWork

  const canCreate =
    !busy &&
    !!title.trim() &&
    !!target.trim() &&
    hasWork &&
    !diffLoading &&
    (onDefaultBranch ? !!newBranchName.trim() : true) &&
    (dirty ? !!commitMessage.trim() : true)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className="relative flex flex-col rounded-xl shadow-2xl"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          width: 1360,
          maxWidth: 'calc(100vw - 48px)',
          height: 'calc(100vh - 64px)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 flex-shrink-0 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>Create Pull Request</h2>
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>
              <span className="font-mono">{effectiveSource}</span>
              <span className="mx-1.5">→</span>
              <span className="font-mono">{target || '…'}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleGenerateAll()}
              disabled={busy || !target.trim()}
              className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-40"
              style={{ background: 'rgba(232,123,95,0.12)', border: '1px solid var(--color-claude)', color: 'var(--color-claude)' }}
              title="Generate branch name, commit message, PR title and description with AI"
            >
              {anyGenerating ? <Spinner /> : <SparkleIcon />}
              {anyGenerating ? 'Generating…' : 'Generate all'}
            </button>
            <button type="button" onClick={onClose} disabled={busy} className="rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40" style={{ color: 'var(--color-text-muted)' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body: split panel */}
        <div className="flex flex-1 min-h-0">
          {/* Left: form */}
          <div className="flex flex-col" style={{ width: 400, flexShrink: 0, borderRight: '1px solid var(--color-border)' }}>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Merge into</label>
                {branchOptions.length > 0 ? (
                  <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} className="w-full rounded px-2 py-1.5 text-sm outline-none" style={inputStyle}>
                    {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                ) : (
                  <input value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} placeholder="Target branch (e.g. main)" className="w-full rounded px-2 py-1.5 text-sm outline-none" style={inputStyle} />
                )}
              </div>

              {onDefaultBranch && (
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>New branch</label>
                  <div className="relative">
                    <input
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      disabled={busy}
                      placeholder="feature/my-change"
                      className="w-full rounded px-2 py-1.5 pr-8 text-sm outline-none font-mono"
                      style={inputStyle}
                    />
                    <button
                      onClick={() => void handleGenerateBranchName()}
                      disabled={busy}
                      className="absolute right-1 top-1.5 rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40"
                      style={{ color: 'var(--color-claude)' }}
                      title="Generate a branch name with AI"
                    >
                      {generatingBranch ? <Spinner /> : <SparkleIcon />}
                    </button>
                  </div>
                  <p className="mt-1 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                    You're on <span className="font-mono">{sourceBranch}</span> — your changes will be moved to this new branch.
                  </p>
                </div>
              )}

              {dirty && (
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                      Uncommitted changes <span style={{ opacity: 0.7 }}>({uncommittedFiles.length})</span>
                    </label>
                  </div>
                  <div className="mb-2 max-h-28 overflow-y-auto rounded" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
                    {uncommittedFiles.map((file, i) => (
                      <div key={`${file.path}-${i}`} className="flex items-center gap-2 px-2 py-1" title={file.path}>
                        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: statusColor(file.status), width: 10, textAlign: 'center', flexShrink: 0 }}>{file.status}</span>
                        <span className="text-[11px] font-mono truncate" style={{ color: 'var(--color-text)' }}>{file.path}</span>
                      </div>
                    ))}
                  </div>
                  <div className="relative">
                    <textarea
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      disabled={busy}
                      placeholder="Commit message"
                      rows={2}
                      className="w-full resize-none rounded px-2 py-1.5 pr-8 text-sm outline-none"
                      style={{ ...inputStyle, fontFamily: 'inherit' }}
                    />
                    <button
                      onClick={() => void handleGenerateCommitMessage()}
                      disabled={busy}
                      className="absolute right-1 top-1.5 rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40"
                      style={{ color: 'var(--color-claude)' }}
                      title="Generate commit message with AI"
                    >
                      {generatingCommit ? <Spinner /> : <SparkleIcon />}
                    </button>
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Title</label>
                <div className="relative">
                  <input
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); setTitleEdited(true) }}
                    disabled={busy}
                    placeholder="PR title"
                    className="w-full rounded px-2 py-1.5 pr-8 text-sm outline-none"
                    style={inputStyle}
                  />
                  <button
                    onClick={() => void handleGenerate()}
                    disabled={busy || !target.trim()}
                    className="absolute right-1 top-1.5 rounded p-1 hover:bg-white/10 transition-colors disabled:opacity-40"
                    style={{ color: 'var(--color-claude)' }}
                    title="Generate PR title and description with AI"
                  >
                    {generating ? <Spinner /> : <SparkleIcon />}
                  </button>
                </div>
              </div>

              <div className="flex flex-1 flex-col min-h-0">
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>Description</label>
                  <button
                    onClick={() => void handleGenerate()}
                    disabled={busy || !target.trim()}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 transition-colors disabled:opacity-40"
                    style={{ color: 'var(--color-claude)' }}
                    title="Generate PR title and description with AI"
                  >
                    {generating ? <Spinner size={10} /> : <SparkleIcon />}
                    Generate
                  </button>
                </div>
                <MarkdownEditor
                  value={description}
                  onChange={setDescription}
                  disabled={busy}
                  placeholder="Describe your changes… (markdown supported)"
                  className="flex-1 min-h-0 overflow-y-auto rounded px-2.5 py-2 text-sm"
                  style={{ ...inputStyle, minHeight: 140 }}
                />
              </div>
            </div>

            {/* Footer (always visible) */}
            <div className="flex flex-col gap-2 border-t p-4 flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
              {nothingToDo && (
                <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                  {onDefaultBranch ? (
                    <>You're on <span className="font-mono">{sourceBranch}</span>. Make some changes to open a pull request.</>
                  ) : (
                    <>No changes to merge from <span className="font-mono">{sourceBranch}</span> into <span className="font-mono">{target}</span>.</>
                  )}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => void handleCreate()}
                  disabled={!canCreate}
                  className="flex-1 rounded py-2 text-xs font-medium transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-claude)', color: '#fff' }}
                >
                  {creating ? 'Creating…' : dirty || onDefaultBranch ? 'Commit & Create PR' : 'Create Pull Request'}
                </button>
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="rounded px-4 py-2 text-xs font-medium transition-opacity disabled:opacity-40"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>

          {/* Right: diffs */}
          <div className="flex flex-1 flex-col min-w-0">
            <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--color-border)' }}>
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                Changes {diffFiles.length > 0 && <span style={{ opacity: 0.7 }}>({diffFiles.length})</span>}
              </span>
              <div className="flex items-center gap-1">
                {diffFiles.length > 0 && (
                  <button
                    onClick={() => setCollapsedFiles(allCollapsed ? new Set() : new Set(diffFiles.map((f) => f.path)))}
                    className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                    title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                  >
                    {allCollapsed ? 'Expand all' : 'Collapse all'}
                  </button>
                )}
                <button
                  onClick={() => void loadDiff()}
                  disabled={diffLoading}
                  className="rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10 transition-colors disabled:opacity-40"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Refresh diff"
                >
                  {diffLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </div>
            {diffLoading && diff === null ? (
              <div className="flex flex-1 items-center justify-center">
                <span className="streaming-dot" style={{ width: 8, height: 8, background: 'var(--color-text-muted)' }} />
              </div>
            ) : diffFiles.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
                No changes between <code className="mx-1">{effectiveSource}</code> and <code className="ml-1">{target}</code>.
              </div>
            ) : (
              <div className="flex flex-1 min-h-0">
                {/* File list sidebar */}
                <div className="overflow-y-auto flex-shrink-0" style={{ width: 220, borderRight: '1px solid var(--color-border)' }}>
                  {diffFiles.map((file, i) => {
                    const name = basename(file.path)
                    const dir = dirname(file.path)
                    const active = activeFile === i
                    return (
                      <button
                        key={`nav-${file.path}-${i}`}
                        onClick={() => scrollToFile(i)}
                        title={file.path}
                        className="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-white/5"
                        style={{
                          background: active ? 'rgba(232,123,95,0.12)' : 'transparent',
                          borderLeft: active ? '2px solid var(--color-claude)' : '2px solid transparent',
                        }}
                      >
                        <span className="w-full truncate text-[11px] font-mono" style={{ color: 'var(--color-text)' }}>{name}</span>
                        {dir && <span className="w-full truncate text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{dir}</span>}
                      </button>
                    )
                  })}
                </div>
                {/* Diffs */}
                <div ref={diffScrollRef} onScroll={handleDiffScroll} className="flex-1 overflow-auto" style={{ background: 'var(--color-surface)' }}>
                  <div className="flex flex-col">
                    {diffFiles.map((file, i) => {
                      const collapsed = collapsedFiles.has(file.path)
                      return (
                        <div
                          key={`${file.path}-${i}`}
                          ref={(el) => { fileRefs.current[i] = el }}
                          style={{ borderBottom: '1px solid var(--color-border)' }}
                        >
                          <button
                            onClick={() => toggleCollapsed(file.path)}
                            title={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
                            className="sticky top-0 z-10 flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-mono hover:bg-white/5 transition-colors"
                            style={{ background: 'var(--color-surface-2)', color: 'var(--color-text)', borderBottom: '1px solid var(--color-border)' }}
                          >
                            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ flexShrink: 0, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', opacity: 0.7 }}>
                              <path d="M0 2l4 4 4-4z" />
                            </svg>
                            <span className="truncate">{file.path}</span>
                          </button>
                          {!collapsed && (
                            <div style={{ fontSize: '0.72rem' }}>
                              <PatchDiff
                                patch={file.patch}
                                options={{ theme: 'pierre-dark', diffStyle: 'unified', disableFileHeader: true, overflow: 'wrap' }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
