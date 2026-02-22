import { create } from 'zustand'
import { ProjectCommand, CommandStatus, CommandLogLine } from '../types/ipc'

export const EMPTY_COMMANDS: ProjectCommand[] = []
export const EMPTY_LOGS: CommandLogLine[] = []

const LOG_RING_BUFFER_SIZE = 1000

interface CommandStore {
  byProject: Record<string, ProjectCommand[]>
  statusMap: Record<string, CommandStatus>
  logsByCommand: Record<string, CommandLogLine[]>
  selectedCommandId: string | null

  fetch: (projectId: string) => Promise<void>
  create: (projectId: string, name: string, command: string, cwd?: string | null) => Promise<void>
  update: (id: string, projectId: string, name: string, command: string, cwd?: string | null) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  start: (commandId: string) => Promise<void>
  stop: (commandId: string) => Promise<void>
  restart: (commandId: string) => Promise<void>
  setStatus: (commandId: string, status: CommandStatus) => void
  appendLog: (commandId: string, line: CommandLogLine) => void
  fetchLogs: (commandId: string) => Promise<void>
  selectCommand: (commandId: string | null) => void
}

export const useCommandStore = create<CommandStore>((set, get) => ({
  byProject: {},
  statusMap: {},
  logsByCommand: {},
  selectedCommandId: null,

  fetch: async (projectId) => {
    const commands = await window.api.invoke('commands:list', projectId)
    // Fetch status for each command
    const statusEntries = await Promise.all(
      commands.map(async (cmd) => {
        const status = await window.api.invoke('commands:getStatus', cmd.id)
        return [cmd.id, status] as [string, CommandStatus]
      })
    )
    const statusMap: Record<string, CommandStatus> = {}
    for (const [id, status] of statusEntries) {
      statusMap[id] = status
    }
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: commands },
      statusMap: { ...s.statusMap, ...statusMap },
    }))
  },

  create: async (projectId, name, command, cwd) => {
    const created = await window.api.invoke('commands:create', projectId, name, command, cwd)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [...(s.byProject[projectId] ?? []), created],
      },
      statusMap: { ...s.statusMap, [created.id]: 'idle' },
    }))
  },

  update: async (id, projectId, name, command, cwd) => {
    await window.api.invoke('commands:update', id, name, command, cwd)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((c) =>
          c.id === id ? { ...c, name, command, cwd: cwd ?? null } : c
        ),
      },
    }))
  },

  remove: async (id, projectId) => {
    await window.api.invoke('commands:delete', id)
    set((s) => {
      const statusMap = { ...s.statusMap }
      delete statusMap[id]
      const logsByCommand = { ...s.logsByCommand }
      delete logsByCommand[id]
      return {
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((c) => c.id !== id),
        },
        statusMap,
        logsByCommand,
        selectedCommandId: s.selectedCommandId === id ? null : s.selectedCommandId,
      }
    })
  },

  start: async (commandId) => {
    set((s) => ({ statusMap: { ...s.statusMap, [commandId]: 'running' } }))
    await window.api.invoke('commands:start', commandId)
  },

  stop: async (commandId) => {
    await window.api.invoke('commands:stop', commandId)
  },

  restart: async (commandId) => {
    set((s) => ({ statusMap: { ...s.statusMap, [commandId]: 'running' } }))
    await window.api.invoke('commands:restart', commandId)
  },

  setStatus: (commandId, status) => {
    set((s) => ({ statusMap: { ...s.statusMap, [commandId]: status } }))
  },

  appendLog: (commandId, line) => {
    set((s) => {
      const existing = s.logsByCommand[commandId] ?? []
      const updated = [...existing, line]
      if (updated.length > LOG_RING_BUFFER_SIZE) updated.shift()
      return { logsByCommand: { ...s.logsByCommand, [commandId]: updated } }
    })
  },

  fetchLogs: async (commandId) => {
    const logs = await window.api.invoke('commands:getLogs', commandId)
    set((s) => ({ logsByCommand: { ...s.logsByCommand, [commandId]: logs } }))
  },

  selectCommand: (commandId) => {
    set({ selectedCommandId: commandId })
  },
}))
