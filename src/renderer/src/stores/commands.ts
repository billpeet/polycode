import { create } from 'zustand'
import { ProjectCommand, CommandStatus, CommandLogLine } from '../types/ipc'

export const EMPTY_COMMANDS: ProjectCommand[] = []
export const EMPTY_LOGS: CommandLogLine[] = []

const LOG_RING_BUFFER_SIZE = 1000

/** Stable key for a running (commandId, locationId) instance. */
export function instKey(commandId: string, locationId: string): string {
  return `${commandId}:${locationId}`
}

/** Parse a compound instance key back into its parts. */
export function parseInstKey(key: string): { commandId: string; locationId: string } {
  const idx = key.indexOf(':')
  return { commandId: key.slice(0, idx), locationId: key.slice(idx + 1) }
}

interface CommandStore {
  byProject: Record<string, ProjectCommand[]>
  /** Status keyed by instKey(commandId, locationId) */
  statusMap: Record<string, CommandStatus>
  /** Logs keyed by instKey(commandId, locationId) */
  logsByCommand: Record<string, CommandLogLine[]>
  /** Currently viewed instance key, or null */
  selectedInstance: string | null
  /** Pinned instance keys */
  pinnedInstances: string[]

  fetch: (projectId: string) => Promise<void>
  /** Fetch statuses for all commands of a project at the given location. */
  fetchStatuses: (projectId: string, locationId: string) => Promise<void>
  create: (projectId: string, name: string, command: string, cwd?: string | null) => Promise<void>
  update: (id: string, projectId: string, name: string, command: string, cwd?: string | null) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  start: (commandId: string, locationId: string) => Promise<void>
  stop: (commandId: string, locationId: string) => Promise<void>
  restart: (commandId: string, locationId: string) => Promise<void>
  setStatus: (key: string, status: CommandStatus) => void
  appendLog: (key: string, line: CommandLogLine) => void
  fetchLogs: (commandId: string, locationId: string) => Promise<void>
  selectInstance: (key: string | null) => void
  pinInstance: (key: string) => void
  unpinInstance: (key: string) => void
}

export const useCommandStore = create<CommandStore>((set, get) => ({
  byProject: {},
  statusMap: {},
  logsByCommand: {},
  selectedInstance: null,
  pinnedInstances: [],

  fetch: async (projectId) => {
    const commands = await window.api.invoke('commands:list', projectId)
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: commands },
    }))
  },

  fetchStatuses: async (projectId, locationId) => {
    const commands = get().byProject[projectId] ?? []
    const statusEntries = await Promise.all(
      commands.map(async (cmd) => {
        const status = await window.api.invoke('commands:getStatus', cmd.id, locationId)
        return [instKey(cmd.id, locationId), status] as [string, CommandStatus]
      })
    )
    const statusUpdate: Record<string, CommandStatus> = {}
    for (const [key, status] of statusEntries) {
      statusUpdate[key] = status
    }
    set((s) => ({ statusMap: { ...s.statusMap, ...statusUpdate } }))
  },

  create: async (projectId, name, command, cwd) => {
    const created = await window.api.invoke('commands:create', projectId, name, command, cwd)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [...(s.byProject[projectId] ?? []), created],
      },
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
      const logsByCommand = { ...s.logsByCommand }
      // Remove all instance entries for this command
      const prefix = `${id}:`
      for (const key of Object.keys(statusMap)) {
        if (key.startsWith(prefix)) delete statusMap[key]
      }
      for (const key of Object.keys(logsByCommand)) {
        if (key.startsWith(prefix)) delete logsByCommand[key]
      }
      const selectedInstance = s.selectedInstance?.startsWith(prefix) ? null : s.selectedInstance
      const pinnedInstances = s.pinnedInstances.filter((k) => !k.startsWith(prefix))
      return {
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((c) => c.id !== id),
        },
        statusMap,
        logsByCommand,
        selectedInstance,
        pinnedInstances,
      }
    })
  },

  start: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    set((s) => ({ statusMap: { ...s.statusMap, [key]: 'running' } }))
    await window.api.invoke('commands:start', commandId, locationId)
  },

  stop: async (commandId, locationId) => {
    await window.api.invoke('commands:stop', commandId, locationId)
  },

  restart: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    set((s) => ({ statusMap: { ...s.statusMap, [key]: 'running' } }))
    await window.api.invoke('commands:restart', commandId, locationId)
  },

  setStatus: (key, status) => {
    set((s) => ({ statusMap: { ...s.statusMap, [key]: status } }))
  },

  appendLog: (key, line) => {
    set((s) => {
      const existing = s.logsByCommand[key] ?? []
      const updated = [...existing, line]
      if (updated.length > LOG_RING_BUFFER_SIZE) updated.shift()
      return { logsByCommand: { ...s.logsByCommand, [key]: updated } }
    })
  },

  fetchLogs: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    const logs = await window.api.invoke('commands:getLogs', commandId, locationId)
    set((s) => ({ logsByCommand: { ...s.logsByCommand, [key]: logs } }))
  },

  selectInstance: (key) => {
    set({ selectedInstance: key })
  },

  pinInstance: (key) => {
    set((s) => {
      if (s.pinnedInstances.includes(key)) return s
      return { pinnedInstances: [...s.pinnedInstances, key] }
    })
  },

  unpinInstance: (key) => {
    set((s) => ({ pinnedInstances: s.pinnedInstances.filter((k) => k !== key) }))
  },
}))
