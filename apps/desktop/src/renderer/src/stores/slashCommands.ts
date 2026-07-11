import { create } from 'zustand'
import { Provider, SlashCommand } from '../types/ipc'

interface SlashCommandStore {
  /** Commands keyed by scope: projectId or 'global' */
  commandsByScope: Record<string, SlashCommand[]>

  /** Fetch commands for the given projectId (includes global). Pass null for global-only. */
  fetch: (projectId?: string | null, provider?: Provider | null, cwd?: string | null) => Promise<void>

  create: (projectId: string | null, name: string, description: string | null, prompt: string) => Promise<SlashCommand>
  update: (id: string, name: string, description: string | null, prompt: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useSlashCommandStore = create<SlashCommandStore>((set) => ({
  commandsByScope: {},

  fetch: async (projectId, provider, cwd) => {
    const commands = await window.api.invoke('slash-commands:list', projectId ?? null)
    const skills = provider ? await window.api.invoke('skills:list', provider, cwd ?? null) : []
    const key = projectId ?? 'global'
    set((s) => ({ commandsByScope: { ...s.commandsByScope, [key]: [...skills, ...commands] } }))
  },

  create: async (projectId, name, description, prompt) => {
    const cmd = await window.api.invoke('slash-commands:create', projectId, name, description, prompt)
    const commands = await window.api.invoke('slash-commands:list', projectId ?? null)
    const key = projectId ?? 'global'
    set((s) => ({ commandsByScope: { ...s.commandsByScope, [key]: commands } }))
    return cmd
  },

  update: async (id, name, description, prompt) => {
    await window.api.invoke('slash-commands:update', id, name, description, prompt)
    set((s) => {
      const newScope = { ...s.commandsByScope }
      for (const key of Object.keys(newScope)) {
        newScope[key] = newScope[key].map((c) =>
          c.id === id ? { ...c, name, description, prompt, updated_at: new Date().toISOString() } : c
        )
      }
      return { commandsByScope: newScope }
    })
  },

  remove: async (id) => {
    await window.api.invoke('slash-commands:delete', id)
    set((s) => {
      const newScope = { ...s.commandsByScope }
      for (const key of Object.keys(newScope)) {
        newScope[key] = newScope[key].filter((c) => c.id !== id)
      }
      return { commandsByScope: newScope }
    })
  },
}))
