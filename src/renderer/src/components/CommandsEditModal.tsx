import { useState, useEffect } from 'react'
import { useCommandStore, EMPTY_COMMANDS } from '../stores/commands'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useBackdropClose } from '../hooks/useBackdropClose'

interface Props {
  projectId: string
  onClose: () => void
}

type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn'

interface ScriptSuggestion {
  name: string
  command: string
}

/** Lockfile/workspace probes in priority order. First match wins. */
const PM_PROBES: Array<{ file: string; pm: PackageManager }> = [
  { file: 'bun.lock',              pm: 'bun'  },
  { file: 'bun.lockb',             pm: 'bun'  },
  { file: 'pnpm-lock.yaml',        pm: 'pnpm' },
  { file: 'pnpm-workspace.yaml',   pm: 'pnpm' },
  { file: 'yarn.lock',             pm: 'yarn' },
  { file: 'package-lock.json',     pm: 'npm'  },
]

/** All `<pm> run <script>` variants we consider equivalent for dedup. */
function allRunVariants(scriptName: string): string[] {
  return ['npm', 'pnpm', 'bun', 'yarn'].map((pm) => `${pm} run ${scriptName}`)
}

async function detectPackageManager(rootPath: string): Promise<PackageManager> {
  const base = rootPath.replace(/\\/g, '/').replace(/\/$/, '')
  for (const { file, pm } of PM_PROBES) {
    const result = await window.api.invoke('files:read', `${base}/${file}`)
    if (result !== null) return pm
  }
  return 'npm' // fallback
}

const EMPTY_LOCATIONS: import('../types/ipc').RepoLocation[] = []

export default function CommandsEditModal({ projectId, onClose }: Props) {
  const backdropClose = useBackdropClose(onClose)
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId) ?? null)
  const commands = useCommandStore((s) => s.byProject[projectId] ?? EMPTY_COMMANDS)
  const fetch = useCommandStore((s) => s.fetch)
  const createCommand = useCommandStore((s) => s.create)
  const updateCommand = useCommandStore((s) => s.update)
  const removeCommand = useCommandStore((s) => s.remove)

  const locations = useLocationStore((s) => s.byProject[projectId] ?? EMPTY_LOCATIONS)
  const fetchLocations = useLocationStore((s) => s.fetch)

  // Script suggestions from package.json
  const [suggestions, setSuggestions] = useState<ScriptSuggestion[]>([])

  // Edit state
  const [editingCmdId, setEditingCmdId] = useState<string | null>(null)
  const [editCmdName, setEditCmdName] = useState('')
  const [editCmdCommand, setEditCmdCommand] = useState('')
  const [editCmdCwd, setEditCmdCwd] = useState('')
  const [editCmdShell, setEditCmdShell] = useState<string | null>(null)
  const [editCmdError, setEditCmdError] = useState('')

  // Add state
  const [newCmdName, setNewCmdName] = useState('')
  const [newCmdCommand, setNewCmdCommand] = useState('')
  const [newCmdCwd, setNewCmdCwd] = useState('')
  const [newCmdShell, setNewCmdShell] = useState<string | null>(null)
  const [cmdError, setCmdError] = useState('')

  useEffect(() => {
    fetch(projectId)
    fetchLocations(projectId)
  }, [projectId, fetch, fetchLocations])

  // Read package.json from each location, detect package manager, extract unmatched scripts
  useEffect(() => {
    if (locations.length === 0) return

    async function loadSuggestions() {
      const existingCommands = new Set(commands.map((c) => c.command.trim()))
      const seenScript = new Set<string>()
      const found: ScriptSuggestion[] = []

      for (const loc of locations) {
        const base = loc.path.replace(/\\/g, '/').replace(/\/$/, '')
        const pkgPath = `${base}/package.json`
        try {
          const result = await window.api.invoke('files:read', pkgPath)
          if (!result) continue
          const pkg = JSON.parse(result.content) as { scripts?: Record<string, string> }
          if (!pkg.scripts) continue

          const pm = await detectPackageManager(base)

          for (const scriptName of Object.keys(pkg.scripts)) {
            // Skip if any <pm> run <script> variant is already in commands
            if (allRunVariants(scriptName).some((v) => existingCommands.has(v))) continue
            // Skip duplicates across locations
            if (seenScript.has(scriptName)) continue
            seenScript.add(scriptName)
            found.push({ name: scriptName, command: `${pm} run ${scriptName}` })
          }
        } catch {
          // No package.json or parse error — skip silently
        }
      }
      setSuggestions(found)
    }

    loadSuggestions()
  }, [locations, commands])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function applySuggestion(s: ScriptSuggestion) {
    setNewCmdName(s.name)
    setNewCmdCommand(s.command)
    setNewCmdCwd('')
    setNewCmdShell(null)
  }

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
          width: 480,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 flex-shrink-0 border-b"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              Edit Commands
            </h2>
            {project && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {project.name}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Existing commands */}
          {commands.length === 0 && (
            <p className="text-xs py-1" style={{ color: 'var(--color-text-muted)' }}>
              No commands yet.
            </p>
          )}

          <div className="space-y-1">
            {commands.map((cmd) => {
              const isEditingThis = editingCmdId === cmd.id
              return (
                <div key={cmd.id}>
                  <div
                    className="flex items-center gap-2 rounded px-3 py-2"
                    style={{
                      background: 'var(--color-surface)',
                      border: `1px solid ${isEditingThis ? 'var(--color-claude)' : 'var(--color-border)'}`,
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>
                          {cmd.name}
                        </span>
                        {cmd.shell === 'powershell' && (
                          <span
                            className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
                            style={{ background: 'rgba(99, 179, 237, 0.15)', color: '#63b3ed' }}
                          >
                            PS
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono truncate block" style={{ color: 'var(--color-text-muted)' }}>
                        {cmd.command}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (isEditingThis) {
                          setEditingCmdId(null)
                        } else {
                          setEditingCmdId(cmd.id)
                          setEditCmdName(cmd.name)
                          setEditCmdCommand(cmd.command)
                          setEditCmdCwd(cmd.cwd ?? '')
                          setEditCmdShell(cmd.shell ?? null)
                          setEditCmdError('')
                        }
                      }}
                      className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0"
                      style={{ color: isEditingThis ? 'var(--color-claude)' : 'var(--color-text-muted)' }}
                      title="Edit command"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => project && removeCommand(cmd.id, project.id)}
                      className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                      title="Remove command"
                    >
                      ✕
                    </button>
                  </div>

                  {isEditingThis && (
                    <div
                      className="mt-1 rounded-md p-3 space-y-2"
                      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-claude)' }}
                    >
                      <div>
                        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
                        <input
                          type="text"
                          value={editCmdName}
                          onChange={(e) => setEditCmdName(e.target.value)}
                          className="w-full rounded px-3 py-1.5 text-sm outline-none"
                          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Command</label>
                        <input
                          type="text"
                          value={editCmdCommand}
                          onChange={(e) => setEditCmdCommand(e.target.value)}
                          className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          Working dir <span style={{ opacity: 0.5 }}>(optional)</span>
                        </label>
                        <input
                          type="text"
                          value={editCmdCwd}
                          onChange={(e) => setEditCmdCwd(e.target.value)}
                          className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                          placeholder="/path/to/subdir"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                          Shell <span style={{ opacity: 0.5 }}>(local only)</span>
                        </label>
                        <div className="flex gap-1">
                          {[{ value: null, label: 'Default' }, { value: 'powershell', label: 'PowerShell' }].map((opt) => (
                            <button
                              key={String(opt.value)}
                              type="button"
                              onClick={() => setEditCmdShell(opt.value)}
                              className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                              style={{
                                background: editCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-surface-2)',
                                color: editCmdShell === opt.value ? '#fff' : 'var(--color-text-muted)',
                                border: `1px solid ${editCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-border)'}`,
                              }}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {editCmdError && <p className="text-xs" style={{ color: '#f87171' }}>{editCmdError}</p>}
                      <div className="flex justify-end gap-2 pt-0.5">
                        <button
                          type="button"
                          onClick={() => setEditingCmdId(null)}
                          className="rounded px-3 py-1.5 text-xs"
                          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={!editCmdName.trim() || !editCmdCommand.trim()}
                          onClick={async () => {
                            if (!project || !editCmdName.trim() || !editCmdCommand.trim()) return
                            setEditCmdError('')
                            try {
                              await updateCommand(cmd.id, project.id, editCmdName.trim(), editCmdCommand.trim(), editCmdCwd.trim() || null, editCmdShell)
                              setEditingCmdId(null)
                            } catch (err) {
                              setEditCmdError(String(err))
                            }
                          }}
                          className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                          style={{ background: 'var(--color-claude)', color: '#fff' }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* package.json suggestions */}
          {suggestions.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
                From package.json
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => applySuggestion(s)}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors hover:bg-white/10"
                    style={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-muted)',
                    }}
                    title={`npm run ${s.name}`}
                  >
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0, opacity: 0.6 }}>
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                      <path d="M6.271 5.055a.5.5 0 0 1 .52.038l3.5 2.5a.5.5 0 0 1 0 .814l-3.5 2.5A.5.5 0 0 1 6 10.5v-5a.5.5 0 0 1 .271-.445z"/>
                    </svg>
                    <span className="font-mono">{s.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Add command form */}
          <div
            className="rounded-md p-3 space-y-2"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          >
            <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Add Command</p>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
              <input
                type="text"
                value={newCmdName}
                onChange={(e) => setNewCmdName(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-sm outline-none"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                placeholder="Dev server"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Command</label>
              <input
                type="text"
                value={newCmdCommand}
                onChange={(e) => setNewCmdCommand(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                placeholder="npm run dev"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Working dir <span style={{ opacity: 0.5 }}>(optional — defaults to location path)</span>
              </label>
              <input
                type="text"
                value={newCmdCwd}
                onChange={(e) => setNewCmdCwd(e.target.value)}
                className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                placeholder="/path/to/subdir"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Shell <span style={{ opacity: 0.5 }}>(local only)</span>
              </label>
              <div className="flex gap-1">
                {[{ value: null, label: 'Default' }, { value: 'powershell', label: 'PowerShell' }].map((opt) => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => setNewCmdShell(opt.value)}
                    className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                    style={{
                      background: newCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-surface-2)',
                      color: newCmdShell === opt.value ? '#fff' : 'var(--color-text-muted)',
                      border: `1px solid ${newCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-border)'}`,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {cmdError && <p className="text-xs" style={{ color: '#f87171' }}>{cmdError}</p>}
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!newCmdName.trim() || !newCmdCommand.trim()}
                onClick={async () => {
                  if (!project || !newCmdName.trim() || !newCmdCommand.trim()) return
                  setCmdError('')
                  try {
                    await createCommand(project.id, newCmdName.trim(), newCmdCommand.trim(), newCmdCwd.trim() || null, newCmdShell)
                    setNewCmdName('')
                    setNewCmdCommand('')
                    setNewCmdCwd('')
                    setNewCmdShell(null)
                  } catch (err) {
                    setCmdError(String(err))
                  }
                }}
                className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                style={{ background: 'var(--color-claude)', color: '#fff' }}
              >
                Add Command
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end px-5 py-3 flex-shrink-0 border-t"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-1.5 text-xs font-medium"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
