import { ConnectionType, LocationPool, Project, RepoLocation } from '../../types/ipc'

export type LocationFormState = { mode: 'none' } | { mode: 'create' } | { mode: 'edit'; location: RepoLocation }

export interface ProjectDialogProps {
  mode: 'create' | 'edit'
  project?: Project
  onClose: () => void
  onCreated?: (project: Project) => void
}

export interface LocationFormSectionProps {
  projectId: string
  location?: RepoLocation
  pools: LocationPool[]
  gitUrl?: string | null
  onSaved: () => void
  onCancel: () => void
}

export function connectionBadge(connType: ConnectionType) {
  if (connType === 'local') return null
  const isSSH = connType === 'ssh'
  return (
    <span
      className="ml-1.5 flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
      style={{
        background: isSSH ? 'rgba(99, 179, 237, 0.15)' : 'rgba(251, 191, 36, 0.15)',
        color: isSSH ? '#63b3ed' : '#fbbf24',
      }}
    >
      {connType}
    </span>
  )
}
