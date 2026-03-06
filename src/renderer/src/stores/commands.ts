import { create } from 'zustand'
import { ProjectCommand, CommandStatus, CommandLogLine } from '../types/ipc'

export const EMPTY_COMMANDS: ProjectCommand[] = []
export const EMPTY_LOGS: CommandLogLine[] = []

const LOG_RING_BUFFER_SIZE = 1000
const LOG_FLUSH_INTERVAL_MS = 50

function sameNumberArray(a: number[] | undefined, b: number[]): boolean {
  if (!a) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

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
  /** Listening ports keyed by instKey(commandId, locationId) */
  portsMap: Record<string, number[]>
  /** Logs keyed by instKey(commandId, locationId) */
  logsByCommand: Record<string, CommandLogLine[]>
  /** Currently viewed instance key per locationId, or null */
  selectedInstanceByLocation: Record<string, string | null>
  /** Pinned instance keys per locationId */
  pinnedInstancesByLocation: Record<string, string[]>

  fetch: (projectId: string) => Promise<void>
  /** Fetch statuses for all commands of a project at the given location. */
  fetchStatuses: (projectId: string, locationId: string) => Promise<void>
  create: (projectId: string, name: string, command: string, cwd?: string | null, shell?: string | null) => Promise<void>
  update: (id: string, projectId: string, name: string, command: string, cwd?: string | null, shell?: string | null) => Promise<void>
  remove: (id: string, projectId: string) => Promise<void>
  start: (commandId: string, locationId: string) => Promise<void>
  stop: (commandId: string, locationId: string) => Promise<void>
  restart: (commandId: string, locationId: string) => Promise<void>
  setStatus: (key: string, status: CommandStatus) => void
  setPorts: (key: string, ports: number[]) => void
  fetchPorts: (commandId: string, locationId: string) => Promise<void>
  appendLog: (key: string, line: CommandLogLine) => void
  fetchLogs: (commandId: string, locationId: string) => Promise<void>
  selectInstance: (key: string | null, locationId: string) => void
  pinInstance: (key: string, locationId: string) => void
  unpinInstance: (key: string, locationId: string) => void
}

const pendingLogsByKey = new Map<string, CommandLogLine[]>()
let logFlushTimer: ReturnType<typeof setTimeout> | null = null

export const useCommandStore = create<CommandStore>((set, get) => ({
  byProject: {},
  statusMap: {},
  portsMap: {},
  logsByCommand: {},
  selectedInstanceByLocation: {},
  pinnedInstancesByLocation: {},

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

  create: async (projectId, name, command, cwd, shell) => {
    const created = await window.api.invoke('commands:create', projectId, name, command, cwd, shell)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: [...(s.byProject[projectId] ?? []), created],
      },
    }))
  },

  update: async (id, projectId, name, command, cwd, shell) => {
    await window.api.invoke('commands:update', id, name, command, cwd, shell)
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: (s.byProject[projectId] ?? []).map((c) =>
          c.id === id ? { ...c, name, command, cwd: cwd ?? null, shell: shell ?? null } : c
        ),
      },
    }))
  },

  remove: async (id, projectId) => {
    await window.api.invoke('commands:delete', id)
    set((s) => {
      const statusMap = { ...s.statusMap }
      const portsMap = { ...s.portsMap }
      const logsByCommand = { ...s.logsByCommand }
      // Remove all instance entries for this command
      const prefix = `${id}:`
      for (const key of Object.keys(statusMap)) {
        if (key.startsWith(prefix)) delete statusMap[key]
      }
      for (const key of Object.keys(portsMap)) {
        if (key.startsWith(prefix)) delete portsMap[key]
      }
      for (const key of Object.keys(logsByCommand)) {
        if (key.startsWith(prefix)) delete logsByCommand[key]
      }
      // Clean up per-location selected/pinned
      const selectedInstanceByLocation = { ...s.selectedInstanceByLocation }
      for (const [loc, sel] of Object.entries(selectedInstanceByLocation)) {
        if (sel?.startsWith(prefix)) selectedInstanceByLocation[loc] = null
      }
      const pinnedInstancesByLocation = { ...s.pinnedInstancesByLocation }
      for (const [loc, pins] of Object.entries(pinnedInstancesByLocation)) {
        pinnedInstancesByLocation[loc] = pins.filter((k) => !k.startsWith(prefix))
      }
      return {
        byProject: {
          ...s.byProject,
          [projectId]: (s.byProject[projectId] ?? []).filter((c) => c.id !== id),
        },
        statusMap,
        portsMap,
        logsByCommand,
        selectedInstanceByLocation,
        pinnedInstancesByLocation,
      }
    })
  },

  start: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    set((s) => ({ statusMap: { ...s.statusMap, [key]: 'running' } }))
    await window.api.invoke('commands:start', commandId, locationId)
  },

  stop: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    set((s) => ({ statusMap: { ...s.statusMap, [key]: 'stopping' } }))
    await window.api.invoke('commands:stop', commandId, locationId)
  },

  restart: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    pendingLogsByKey.delete(key)
    set((s) => ({
      statusMap: { ...s.statusMap, [key]: 'stopping' },
      logsByCommand: { ...s.logsByCommand, [key]: [] },
    }))
    await window.api.invoke('commands:restart', commandId, locationId)
  },

  setStatus: (key, status) => {
    set((s) => {
      if (s.statusMap[key] === status) return s
      return { statusMap: { ...s.statusMap, [key]: status } }
    })
  },

  setPorts: (key, ports) => {
    set((s) => {
      if (sameNumberArray(s.portsMap[key], ports)) return s
      return { portsMap: { ...s.portsMap, [key]: ports } }
    })
  },

  fetchPorts: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    const ports = await window.api.invoke('commands:getPorts', commandId, locationId)
    set((s) => ({ portsMap: { ...s.portsMap, [key]: ports } }))
  },

  appendLog: (key, line) => {
    const pending = pendingLogsByKey.get(key) ?? []
    pending.push(line)
    pendingLogsByKey.set(key, pending)

    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null
        if (pendingLogsByKey.size === 0) return
        set((s) => {
          let nextLogsByCommand: Record<string, CommandLogLine[]> | null = null
          for (const [pendingKey, lines] of pendingLogsByKey.entries()) {
            if (lines.length === 0) continue
            const existing = s.logsByCommand[pendingKey] ?? EMPTY_LOGS
            const merged = existing.length === 0 ? lines : existing.concat(lines)
            const trimmed =
              merged.length > LOG_RING_BUFFER_SIZE
                ? merged.slice(merged.length - LOG_RING_BUFFER_SIZE)
                : merged
            if (!nextLogsByCommand) nextLogsByCommand = { ...s.logsByCommand }
            nextLogsByCommand[pendingKey] = trimmed
          }
          pendingLogsByKey.clear()
          if (!nextLogsByCommand) return s
          return { logsByCommand: nextLogsByCommand }
        })
      }, LOG_FLUSH_INTERVAL_MS)
    }
  },

  fetchLogs: async (commandId, locationId) => {
    const key = instKey(commandId, locationId)
    const logs = await window.api.invoke('commands:getLogs', commandId, locationId)
    const pending = pendingLogsByKey.get(key) ?? EMPTY_LOGS
    if (pending.length > 0) pendingLogsByKey.delete(key)
    const merged = pending.length > 0 ? logs.concat(pending) : logs
    const trimmed =
      merged.length > LOG_RING_BUFFER_SIZE
        ? merged.slice(merged.length - LOG_RING_BUFFER_SIZE)
        : merged
    set((s) => ({ logsByCommand: { ...s.logsByCommand, [key]: trimmed } }))
  },

  selectInstance: (key, locationId) => {
    set((s) => ({
      selectedInstanceByLocation: { ...s.selectedInstanceByLocation, [locationId]: key },
    }))
  },

  pinInstance: (key, locationId) => {
    set((s) => {
      const existing = s.pinnedInstancesByLocation[locationId] ?? []
      if (existing.includes(key)) return s
      return { pinnedInstancesByLocation: { ...s.pinnedInstancesByLocation, [locationId]: [...existing, key] } }
    })
  },

  unpinInstance: (key, locationId) => {
    set((s) => {
      const existing = s.pinnedInstancesByLocation[locationId] ?? []
      return { pinnedInstancesByLocation: { ...s.pinnedInstancesByLocation, [locationId]: existing.filter((k) => k !== key) } }
    })
  },
}))
