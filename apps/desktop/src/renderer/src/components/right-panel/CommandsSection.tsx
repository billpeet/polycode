import { useEffect, useState } from 'react'
import CommandsEditModal from '../CommandsEditModal'
import { useFilesStore } from '../../stores/files'
import { useCommandStore, EMPTY_COMMANDS, instKey } from '../../stores/commands'
import { useThreadStore } from '../../stores/threads'
import { CommandStatus } from '../../types/ipc'

function StatusDot({ status }: { status: CommandStatus }) {
  const color =
    status === 'running' ? '#4ade80'
    : status === 'stopping' ? '#fb923c'
    : status === 'error' ? '#f87171'
    : 'var(--color-text-muted)'

  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  )
}

export default function CommandsSection({ threadId }: { threadId: string }) {
  const byProject = useThreadStore((s) => s.byProject)
  const archivedByProject = useThreadStore((s) => s.archivedByProject)
  const thread = Object.values(byProject).flat().find((t) => t.id === threadId)
    ?? Object.values(archivedByProject).flat().find((t) => t.id === threadId)
  const projectId = thread?.project_id ?? null
  const locationId = thread?.location_id ?? null

  const [editModalOpen, setEditModalOpen] = useState(false)

  const commands = useCommandStore((s) => {
    if (!projectId) return EMPTY_COMMANDS
    return s.byProject[projectId] ?? EMPTY_COMMANDS
  })
  const statusMap = useCommandStore((s) => s.statusMap)
  const portsMap = useCommandStore((s) => s.portsMap)
  const fetch = useCommandStore((s) => s.fetch)
  const fetchStatuses = useCommandStore((s) => s.fetchStatuses)
  const fetchPorts = useCommandStore((s) => s.fetchPorts)
  const start = useCommandStore((s) => s.start)
  const stop = useCommandStore((s) => s.stop)
  const restart = useCommandStore((s) => s.restart)
  const setStatus = useCommandStore((s) => s.setStatus)
  const setPorts = useCommandStore((s) => s.setPorts)
  const selectInstance = useCommandStore((s) => s.selectInstance)
  const pinInstance = useCommandStore((s) => s.pinInstance)
  const fetchLogs = useCommandStore((s) => s.fetchLogs)
  const clearFileSelection = useFilesStore((s) => s.clearSelection)

  useEffect(() => {
    if (projectId) fetch(projectId)
  }, [projectId, fetch])

  useEffect(() => {
    if (projectId && locationId) fetchStatuses(projectId, locationId)
  }, [projectId, locationId, fetchStatuses])

  useEffect(() => {
    if (commands.length === 0 || !locationId) return
    void Promise.all(commands.map((cmd) => fetchPorts(cmd.id, locationId)))
  }, [commands, locationId, fetchPorts])

  useEffect(() => {
    if (commands.length === 0 || !locationId) return
    const unsubs = commands.map((cmd) => {
      const key = instKey(cmd.id, locationId)
      return window.api.on(`command:status:${key}`, (status) => {
        setStatus(key, status as CommandStatus)
      })
    })
    return () => { for (const unsub of unsubs) unsub() }
  }, [commands, locationId, setStatus])

  useEffect(() => {
    if (commands.length === 0 || !locationId) return
    const unsubs = commands.map((cmd) => {
      const key = instKey(cmd.id, locationId)
      return window.api.on(`command:ports:${key}`, (ports) => {
        setPorts(key, ports as number[])
      })
    })
    return () => { for (const unsub of unsubs) unsub() }
  }, [commands, locationId, setPorts])

  if (!projectId) return null

  return (
    <>
      {editModalOpen && (
        <CommandsEditModal projectId={projectId} onClose={() => setEditModalOpen(false)} />
      )}
      <div className="px-3 py-3">
        <div className="flex justify-end mb-2">
          <button
            type="button"
            onClick={() => setEditModalOpen(true)}
            className="text-xs hover:underline"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Edit commands
          </button>
        </div>
        {commands.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--color-text-muted)' }}>
            No commands yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {commands.map((cmd) => {
              const key = locationId ? instKey(cmd.id, locationId) : null
              const status: CommandStatus = (key ? statusMap[key] : null) ?? 'idle'
              const ports = key ? (portsMap[key] ?? []) : []
              const isActive = status === 'running' || status === 'stopping'
              const isStopping = status === 'stopping'

              return (
                <li
                  key={cmd.id}
                  className="rounded px-2 py-2"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <StatusDot status={status} />
                    <button
                      className="flex-1 text-left text-xs font-medium truncate hover:underline"
                      style={{ color: 'var(--color-text)' }}
                      onClick={() => {
                        if (!locationId) return
                        clearFileSelection()
                        selectInstance(instKey(cmd.id, locationId), locationId)
                        fetchLogs(cmd.id, locationId)
                      }}
                      title={cmd.command}
                    >
                      {cmd.name}
                    </button>
                  </div>
                  <p className="text-[10px] font-mono truncate mb-2" style={{ color: 'var(--color-text-muted)' }}>
                    {cmd.command}
                  </p>
                  {ports.length > 0 && (
                    <p className="text-[10px] font-mono truncate mb-2" style={{ color: '#4ade80' }}>
                      ports: {ports.join(', ')}
                    </p>
                  )}
                  <div className="flex gap-1">
                    {!isActive ? (
                      <button
                        onClick={() => {
                          if (!locationId) return
                          const instanceKey = instKey(cmd.id, locationId)
                          start(cmd.id, locationId)
                          pinInstance(instanceKey, locationId)
                          selectInstance(instanceKey, locationId)
                          fetchLogs(cmd.id, locationId)
                        }}
                        disabled={!locationId}
                        className="flex-1 rounded py-1 text-xs font-medium transition-colors disabled:opacity-40"
                        style={{ background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' }}
                      >
                        Start
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            if (!locationId) return
                            const instanceKey = instKey(cmd.id, locationId)
                            restart(cmd.id, locationId)
                            pinInstance(instanceKey, locationId)
                            selectInstance(instanceKey, locationId)
                            fetchLogs(cmd.id, locationId)
                          }}
                          disabled={isStopping}
                          className="flex-1 rounded py-1 text-xs font-medium transition-colors disabled:opacity-50"
                          style={{ background: 'rgba(232, 123, 95, 0.15)', color: 'var(--color-claude)', border: '1px solid rgba(232, 123, 95, 0.3)' }}
                        >
                          Restart
                        </button>
                        <button
                          onClick={() => locationId && stop(cmd.id, locationId)}
                          disabled={isStopping}
                          className="flex-1 rounded py-1 text-xs font-medium transition-colors disabled:opacity-50"
                          style={{ background: 'rgba(248, 113, 113, 0.15)', color: '#f87171', border: '1px solid rgba(248, 113, 113, 0.3)' }}
                        >
                          {isStopping ? 'Stopping…' : 'Stop'}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}
