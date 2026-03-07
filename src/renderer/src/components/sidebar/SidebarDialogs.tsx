import { Project, RepoLocation } from '../../types/ipc'
import LocationDialog from '../LocationDialog'
import ProjectDialog from '../ProjectDialog'
import SettingsDialog from '../SettingsDialog'

export interface SidebarProjectDialogStateCreate {
  mode: 'create'
}

export interface SidebarProjectDialogStateEdit {
  mode: 'edit'
  project: Project
}

export type SidebarProjectDialogState = SidebarProjectDialogStateCreate | SidebarProjectDialogStateEdit

export interface SidebarLocationDialogStateCreate {
  mode: 'create'
  projectId: string
}

export interface SidebarLocationDialogStateEdit {
  mode: 'edit'
  projectId: string
  location: RepoLocation
}

export type SidebarLocationDialogState = SidebarLocationDialogStateCreate | SidebarLocationDialogStateEdit

export interface SidebarConfirmDeleteState {
  type: 'project' | 'thread'
  id: string
  name: string
  projectId: string
}

interface SidebarDialogsProps {
  projectDialog: SidebarProjectDialogState | null
  locationDialog: SidebarLocationDialogState | null
  confirmDelete: SidebarConfirmDeleteState | null
  settingsOpen: boolean
  selectedProjectId: string | null
  selectedProjectName?: string
  onCloseProjectDialog: () => void
  onCloseLocationDialog: (projectId: string) => void
  onCloseConfirmDelete: () => void
  onDeleteProject: (projectId: string) => void | Promise<void>
  onDeleteThread: (threadId: string, projectId: string) => void | Promise<void>
  onCloseSettings: () => void
}

export default function SidebarDialogs({
  projectDialog,
  locationDialog,
  confirmDelete,
  settingsOpen,
  selectedProjectId,
  selectedProjectName,
  onCloseProjectDialog,
  onCloseLocationDialog,
  onCloseConfirmDelete,
  onDeleteProject,
  onDeleteThread,
  onCloseSettings,
}: SidebarDialogsProps) {
  return (
    <>
      {projectDialog && (
        <ProjectDialog
          mode={projectDialog.mode}
          project={projectDialog.mode === 'edit' ? projectDialog.project : undefined}
          onClose={onCloseProjectDialog}
        />
      )}

      {locationDialog && (
        <LocationDialog
          mode={locationDialog.mode}
          projectId={locationDialog.projectId}
          location={locationDialog.mode === 'edit' ? locationDialog.location : undefined}
          onClose={() => onCloseLocationDialog(locationDialog.projectId)}
        />
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={onCloseConfirmDelete}
        >
          <div
            className="w-80 rounded-lg p-5 shadow-2xl"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-1 text-sm" style={{ color: 'var(--color-text)' }}>
              Delete {confirmDelete.type}?
            </p>
            <p className="mb-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span className="font-mono" style={{ color: 'var(--color-text)' }}>{confirmDelete.name}</span>
              {confirmDelete.type === 'project' && ' and all its threads will be permanently deleted.'}
              {confirmDelete.type === 'thread' && ' and all its messages will be permanently deleted.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={onCloseConfirmDelete}
                className="rounded px-3 py-1.5 text-xs"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  confirmDelete.type === 'project'
                    ? onDeleteProject(confirmDelete.id)
                    : onDeleteThread(confirmDelete.id, confirmDelete.projectId)
                }
                className="rounded px-3 py-1.5 text-xs font-medium"
                style={{ background: '#dc2626', color: '#fff' }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog
          projectId={selectedProjectId ?? null}
          projectName={selectedProjectName}
          onClose={onCloseSettings}
        />
      )}
    </>
  )
}
