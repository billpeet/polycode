import { useState } from 'react'
import { EMPTY_COMMANDS, useCommandStore } from '../../stores/commands'
import { LocationPool, Project, RepoLocation } from '../../types/ipc'
import LocationFormSection from './LocationFormSection'
import { connectionBadge, LocationFormState } from './types'

export function PoolsSection({
  pools,
  locations,
  newPoolName,
  setNewPoolName,
  onCreatePool,
  onSavePool,
  onDeletePool,
}: {
  pools: LocationPool[]
  locations: RepoLocation[]
  newPoolName: string
  setNewPoolName: (value: string) => void
  onCreatePool: () => Promise<void>
  onSavePool: (poolId: string, name: string) => Promise<void>
  onDeletePool: (poolId: string) => Promise<void>
}) {
  const [editingPoolId, setEditingPoolId] = useState<string | null>(null)
  const [editingPoolName, setEditingPoolName] = useState('')

  return (
    <>
      <div className="my-5 border-t" style={{ borderColor: 'var(--color-border)' }} />
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>Location Pools</span>
      </div>
      {pools.length === 0 && (
        <p className="text-xs py-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>
          No pools yet. Locations will behave as before until you create one.
        </p>
      )}
      <div className="space-y-1 mb-2">
        {pools.map((pool) => {
          const inUseCount = locations.filter((l) => l.pool_id === pool.id).length
          const isEditing = editingPoolId === pool.id
          return (
            <div key={pool.id} className="flex items-center gap-2 rounded px-3 py-2" style={{ background: 'var(--color-surface)', border: `1px solid ${isEditing ? 'var(--color-claude)' : 'var(--color-border)'}` }}>
              {isEditing ? (
                <input type="text" value={editingPoolName} onChange={(e) => setEditingPoolName(e.target.value)} className="flex-1 rounded px-2 py-1 text-xs outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} autoFocus />
              ) : (
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>{pool.name}</span>
                  <span className="ml-2 text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{inUseCount} location{inUseCount === 1 ? '' : 's'}</span>
                </div>
              )}
              {isEditing ? (
                <>
                  <button type="button" onClick={() => void onSavePool(pool.id, editingPoolName).then(() => { setEditingPoolId(null); setEditingPoolName('') })} className="rounded px-2 py-1 text-[10px]" style={{ background: 'var(--color-claude)', color: '#fff' }}>
                    Save
                  </button>
                  <button type="button" onClick={() => { setEditingPoolId(null); setEditingPoolName('') }} className="rounded px-2 py-1 text-[10px]" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => { setEditingPoolId(pool.id); setEditingPoolName(pool.name) }} className="rounded p-1 text-xs hover:bg-white/10 transition-colors" style={{ color: 'var(--color-text-muted)' }} title="Edit pool">✎</button>
                  <button type="button" onClick={() => void onDeletePool(pool.id).then(() => { if (editingPoolId === pool.id) { setEditingPoolId(null); setEditingPoolName('') } })} className="rounded p-1 text-xs hover:bg-white/10 transition-colors" style={{ color: 'var(--color-text-muted)' }} title="Delete pool">✕</button>
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-2 mb-4">
        <input type="text" value={newPoolName} onChange={(e) => setNewPoolName(e.target.value)} className="flex-1 rounded px-3 py-1.5 text-xs outline-none" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="New pool name" />
        <button type="button" onClick={() => void onCreatePool()} disabled={!newPoolName.trim()} className="rounded px-2.5 py-1 text-xs disabled:opacity-50" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
          + Add Pool
        </button>
      </div>
    </>
  )
}

export function LocationsSection({
  project,
  pools,
  locations,
  locationForm,
  setLocationForm,
  deleteConfirm,
  setDeleteConfirm,
  gitUrl,
  onDeleteLocation,
}: {
  project: Project
  pools: LocationPool[]
  locations: RepoLocation[]
  locationForm: LocationFormState
  setLocationForm: (value: LocationFormState) => void
  deleteConfirm: RepoLocation | null
  setDeleteConfirm: (value: RepoLocation | null) => void
  gitUrl: string | null
  onDeleteLocation: (loc: RepoLocation) => Promise<void>
}) {
  return (
    <>
      <div className="my-5 border-t" style={{ borderColor: 'var(--color-border)' }} />
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>Locations</span>
        {locationForm.mode === 'none' && <button type="button" onClick={() => setLocationForm({ mode: 'create' })} className="rounded px-2.5 py-1 text-xs" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>+ Add Location</button>}
      </div>
      {locations.length === 0 && locationForm.mode === 'none' && <p className="text-xs py-1" style={{ color: 'var(--color-text-muted)' }}>No locations yet. Add a location to start working.</p>}
      <div className="space-y-1">
        {locations.map((loc) => {
          const isEditingThis = locationForm.mode === 'edit' && locationForm.location.id === loc.id
          return (
            <div key={loc.id}>
              <div className="flex items-center gap-2 rounded px-3 py-2" style={{ background: 'var(--color-surface)', border: `1px solid ${isEditingThis ? 'var(--color-claude)' : 'var(--color-border)'}` }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center min-w-0">
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>{loc.label}</span>
                    {loc.pool_id && <span className="ml-1.5 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }}>{pools.find((p) => p.id === loc.pool_id)?.name ?? 'Pool'}</span>}
                    {connectionBadge(loc.connection_type)}
                  </div>
                  <span className="text-[10px] font-mono truncate block" style={{ color: 'var(--color-text-muted)' }}>
                    {loc.connection_type === 'ssh' ? `${loc.ssh?.user}@${loc.ssh?.host}:${loc.path}` : loc.path}
                  </span>
                </div>
                <button type="button" onClick={() => setLocationForm(isEditingThis ? { mode: 'none' } : { mode: 'edit', location: loc })} className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0" style={{ color: isEditingThis ? 'var(--color-claude)' : 'var(--color-text-muted)' }} title="Edit location">✎</button>
                <button type="button" onClick={() => setDeleteConfirm(loc)} className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} title="Delete location">✕</button>
              </div>
              {isEditingThis && <LocationFormSection projectId={project.id} location={loc} pools={pools} onSaved={() => setLocationForm({ mode: 'none' })} onCancel={() => setLocationForm({ mode: 'none' })} />}
            </div>
          )
        })}
      </div>
      {locationForm.mode === 'create' && <div className={locations.length > 0 ? 'mt-1' : ''}><LocationFormSection projectId={project.id} pools={pools} gitUrl={gitUrl} onSaved={() => setLocationForm({ mode: 'none' })} onCancel={() => setLocationForm({ mode: 'none' })} /></div>}
      {deleteConfirm && (
        <div className="mt-3 rounded-md p-3" style={{ background: 'rgba(220, 38, 38, 0.1)', border: '1px solid rgba(220, 38, 38, 0.3)' }}>
          <p className="text-xs mb-2" style={{ color: 'var(--color-text)' }}>Delete location <strong>{deleteConfirm.label}</strong>?</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDeleteConfirm(null)} className="rounded px-3 py-1 text-xs" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>Cancel</button>
            <button type="button" onClick={() => void onDeleteLocation(deleteConfirm)} className="rounded px-3 py-1 text-xs font-medium" style={{ background: '#dc2626', color: '#fff' }}>Delete</button>
          </div>
        </div>
      )}
    </>
  )
}

export function CommandsSection({ project }: { project: Project }) {
  const commands = useCommandStore((s) => s.byProject[project.id] ?? EMPTY_COMMANDS)
  const updateCommand = useCommandStore((s) => s.update)
  const removeCommand = useCommandStore((s) => s.remove)
  const createCommand = useCommandStore((s) => s.create)

  const [newCmdName, setNewCmdName] = useState('')
  const [newCmdCommand, setNewCmdCommand] = useState('')
  const [newCmdCwd, setNewCmdCwd] = useState('')
  const [newCmdShell, setNewCmdShell] = useState<string | null>(null)
  const [cmdError, setCmdError] = useState('')
  const [editingCmdId, setEditingCmdId] = useState<string | null>(null)
  const [editCmdName, setEditCmdName] = useState('')
  const [editCmdCommand, setEditCmdCommand] = useState('')
  const [editCmdCwd, setEditCmdCwd] = useState('')
  const [editCmdShell, setEditCmdShell] = useState<string | null>(null)
  const [editCmdError, setEditCmdError] = useState('')

  return (
    <>
      <div className="my-5 border-t" style={{ borderColor: 'var(--color-border)' }} />
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>Commands</span>
      </div>
      {commands.length === 0 && <p className="text-xs py-1 mb-2" style={{ color: 'var(--color-text-muted)' }}>No commands yet.</p>}
      <div className="space-y-1 mb-3">
        {commands.map((cmd) => {
          const isEditingThis = editingCmdId === cmd.id
          return (
            <div key={cmd.id}>
              <div className="flex items-center gap-2 rounded px-3 py-2" style={{ background: 'var(--color-surface)', border: `1px solid ${isEditingThis ? 'var(--color-claude)' : 'var(--color-border)'}` }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>{cmd.name}</span>
                    {cmd.shell === 'powershell' && <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase" style={{ background: 'rgba(99, 179, 237, 0.15)', color: '#63b3ed' }}>PS</span>}
                  </div>
                  <span className="text-[10px] font-mono truncate block" style={{ color: 'var(--color-text-muted)' }}>{cmd.command}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (isEditingThis) setEditingCmdId(null)
                    else {
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
                <button type="button" onClick={() => void removeCommand(cmd.id, project.id)} className="rounded p-1 text-xs hover:bg-white/10 transition-colors flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} title="Remove command">✕</button>
              </div>
              {isEditingThis && (
                <div className="mt-1 rounded-md p-3 space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-claude)' }}>
                  <div>
                    <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
                    <input type="text" value={editCmdName} onChange={(e) => setEditCmdName(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} autoFocus />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Command</label>
                    <input type="text" value={editCmdCommand} onChange={(e) => setEditCmdCommand(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Working dir <span style={{ opacity: 0.5 }}>(optional)</span></label>
                    <input type="text" value={editCmdCwd} onChange={(e) => setEditCmdCwd(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="/path/to/subdir" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Shell <span style={{ opacity: 0.5 }}>(local only)</span></label>
                    <div className="flex gap-1">
                      {[{ value: null, label: 'Default' }, { value: 'powershell', label: 'PowerShell' }].map((opt) => (
                        <button key={String(opt.value)} type="button" onClick={() => setEditCmdShell(opt.value)} className="rounded px-2.5 py-1 text-xs font-medium transition-colors" style={{ background: editCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-surface-2)', color: editCmdShell === opt.value ? '#fff' : 'var(--color-text-muted)', border: `1px solid ${editCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-border)'}` }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {editCmdError && <p className="text-xs" style={{ color: '#f87171' }}>{editCmdError}</p>}
                  <div className="flex justify-end gap-2 pt-0.5">
                    <button type="button" onClick={() => setEditingCmdId(null)} className="rounded px-3 py-1.5 text-xs" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>Cancel</button>
                    <button
                      type="button"
                      disabled={!editCmdName.trim() || !editCmdCommand.trim()}
                      onClick={async () => {
                        if (!editCmdName.trim() || !editCmdCommand.trim()) return
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
      <div className="rounded-md p-3 space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Add Command</p>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
          <input type="text" value={newCmdName} onChange={(e) => setNewCmdName(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="Dev server" />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Command</label>
          <input type="text" value={newCmdCommand} onChange={(e) => setNewCmdCommand(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="npm run dev" />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Working dir <span style={{ opacity: 0.5 }}>(optional - defaults to location path)</span></label>
          <input type="text" value={newCmdCwd} onChange={(e) => setNewCmdCwd(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="/path/to/subdir" />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Shell <span style={{ opacity: 0.5 }}>(local only)</span></label>
          <div className="flex gap-1">
            {[{ value: null, label: 'Default' }, { value: 'powershell', label: 'PowerShell' }].map((opt) => (
              <button key={String(opt.value)} type="button" onClick={() => setNewCmdShell(opt.value)} className="rounded px-2.5 py-1 text-xs font-medium transition-colors" style={{ background: newCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-surface-2)', color: newCmdShell === opt.value ? '#fff' : 'var(--color-text-muted)', border: `1px solid ${newCmdShell === opt.value ? 'var(--color-claude)' : 'var(--color-border)'}` }}>
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
              if (!newCmdName.trim() || !newCmdCommand.trim()) return
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
    </>
  )
}
