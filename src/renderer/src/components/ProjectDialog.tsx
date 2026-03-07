import { useEffect, useState, type FormEvent } from 'react'
import { useProjectStore } from '../stores/projects'
import { useLocationStore } from '../stores/locations'
import { useCommandStore } from '../stores/commands'
import { LocationPool, RepoLocation } from '../types/ipc'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { CommandsSection, LocationsSection, PoolsSection } from './project-dialog/EditSections'
import { LocationFormState, ProjectDialogProps } from './project-dialog/types'

const EMPTY: RepoLocation[] = []
const EMPTY_POOLS: LocationPool[] = []

export default function ProjectDialog({ mode, project, onClose, onCreated }: ProjectDialogProps) {
  const backdropClose = useBackdropClose(onClose)
  const [name, setName] = useState(project?.name ?? '')
  const [gitUrl, setGitUrl] = useState(project?.git_url ?? '')
  const [error, setError] = useState('')
  const [projectSaved, setProjectSaved] = useState(false)
  const [locationForm, setLocationForm] = useState<LocationFormState>({ mode: 'none' })
  const [deleteConfirm, setDeleteConfirm] = useState<RepoLocation | null>(null)
  const [newPoolName, setNewPoolName] = useState('')

  const createProject = useProjectStore((s) => s.create)
  const updateProject = useProjectStore((s) => s.update)

  const locations = useLocationStore((s) => project ? (s.byProject[project.id] ?? EMPTY) : EMPTY)
  const pools = useLocationStore((s) => project ? (s.poolsByProject[project.id] ?? EMPTY_POOLS) : EMPTY_POOLS)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const fetchPools = useLocationStore((s) => s.fetchPools)
  const removeLocation = useLocationStore((s) => s.remove)
  const createPool = useLocationStore((s) => s.createPool)
  const updatePool = useLocationStore((s) => s.updatePool)
  const removePool = useLocationStore((s) => s.removePool)
  const fetchCommands = useCommandStore((s) => s.fetch)

  const isEdit = mode === 'edit'

  useEffect(() => {
    if (isEdit && project) {
      fetchLocations(project.id)
      fetchPools(project.id)
      fetchCommands(project.id)
    }
  }, [isEdit, project?.id, fetchLocations, fetchPools, fetchCommands, project])

  async function handleProjectSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    try {
      if (isEdit && project) {
        await updateProject(project.id, name.trim(), gitUrl.trim() || null)
        setProjectSaved(true)
        setTimeout(() => setProjectSaved(false), 2000)
      } else {
        const created = await createProject(name.trim(), gitUrl.trim() || null)
        onClose()
        onCreated?.(created)
      }
    } catch (err) {
      setError(String(err))
    }
  }

  async function handleDeleteLocation(loc: RepoLocation): Promise<void> {
    if (!project) return
    await removeLocation(loc.id, project.id)
    setDeleteConfirm(null)
  }

  async function handleCreatePool(): Promise<void> {
    if (!project || !newPoolName.trim()) return
    await createPool(project.id, newPoolName.trim())
    setNewPoolName('')
  }

  async function handleSavePool(poolId: string, poolName: string): Promise<void> {
    if (!project || !poolName.trim()) return
    await updatePool(poolId, project.id, poolName.trim())
  }

  async function handleDeletePool(poolId: string): Promise<void> {
    if (!project) return
    await removePool(poolId, project.id)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className={`${isEdit ? 'w-[520px]' : 'w-96'} max-h-[85vh] overflow-y-auto rounded-lg p-6 shadow-2xl`}
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          {isEdit ? 'Edit Project' : 'New Project'}
        </h2>

        <form onSubmit={handleProjectSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm outline-none"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="My Project"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Git URL <span style={{ opacity: 0.5 }}>(optional)</span>
            </label>
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              className="w-full rounded px-3 py-2 text-sm outline-none font-mono"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              placeholder="https://github.com/org/repo.git"
            />
          </div>

          {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}

          <div className="flex justify-end gap-2">
            {!isEdit && (
              <button type="button" onClick={onClose} className="rounded px-4 py-2 text-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                Cancel
              </button>
            )}
            <button type="submit" className="rounded px-4 py-2 text-sm font-medium transition-colors" style={{ background: projectSaved ? '#16a34a' : 'var(--color-claude)', color: '#fff' }}>
              {isEdit ? (projectSaved ? 'Saved!' : 'Save Changes') : 'Create'}
            </button>
          </div>
        </form>

        {isEdit && project && (
          <>
            <PoolsSection
              pools={pools}
              locations={locations}
              newPoolName={newPoolName}
              setNewPoolName={setNewPoolName}
              onCreatePool={handleCreatePool}
              onSavePool={handleSavePool}
              onDeletePool={handleDeletePool}
            />

            <LocationsSection
              project={project}
              pools={pools}
              locations={locations}
              locationForm={locationForm}
              setLocationForm={setLocationForm}
              deleteConfirm={deleteConfirm}
              setDeleteConfirm={setDeleteConfirm}
              gitUrl={gitUrl.trim() || null}
              onDeleteLocation={handleDeleteLocation}
            />

            <CommandsSection project={project} />

            <div className="mt-5 pt-4 flex justify-end border-t" style={{ borderColor: 'var(--color-border)' }}>
              <button type="button" onClick={onClose} className="rounded px-4 py-2 text-sm" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
