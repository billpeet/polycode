import { create } from 'zustand'
import { Provider, ReasoningLevel, PROVIDERS, getModelsForProvider } from '../types/ipc'

/** A saved provider/model/effort combination, loadable via Ctrl+<slot>. */
export interface Favourite {
  provider: Provider
  model: string
  reasoningLevel: ReasoningLevel
}

/** Slots are 1-based (Ctrl+1 .. Ctrl+9). */
export const FAVOURITE_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

const SETTING_KEY = 'favourites:combos'

const EMPTY: Record<number, Favourite> = {}

interface FavouritesStore {
  /** Map of slot number -> favourite. Missing slots are unset. */
  bySlot: Record<number, Favourite>
  loaded: boolean
  load: () => Promise<void>
  save: (slot: number, fav: Favourite) => Promise<void>
  clear: (slot: number) => Promise<void>
}

function isValid(slot: unknown): slot is number {
  return typeof slot === 'number' && slot >= 1 && slot <= 9
}

function sanitize(raw: unknown): Record<number, Favourite> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<number, Favourite> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = Number(key)
    if (!isValid(slot)) continue
    const fav = value as Partial<Favourite>
    if (fav && typeof fav.provider === 'string' && typeof fav.model === 'string' && typeof fav.reasoningLevel === 'string') {
      out[slot] = { provider: fav.provider as Provider, model: fav.model, reasoningLevel: fav.reasoningLevel as ReasoningLevel }
    }
  }
  return out
}

/** Human-readable label for a favourite, e.g. "Claude Code · Opus 4.8 · max". */
export function formatFavourite(fav: Favourite): string {
  const providerLabel = PROVIDERS.find((p) => p.id === fav.provider)?.label ?? fav.provider
  const modelLabel = getModelsForProvider(fav.provider).find((m) => m.id === fav.model)?.label ?? fav.model
  const parts = [providerLabel, modelLabel]
  if (fav.reasoningLevel && fav.reasoningLevel !== 'off') parts.push(fav.reasoningLevel)
  return parts.join(' · ')
}

async function persist(bySlot: Record<number, Favourite>): Promise<void> {
  await window.api.invoke('settings:set', SETTING_KEY, JSON.stringify(bySlot))
}

export const useFavouritesStore = create<FavouritesStore>((set, get) => ({
  bySlot: EMPTY,
  loaded: false,

  load: async () => {
    try {
      const raw = await window.api.invoke('settings:get', SETTING_KEY)
      const bySlot = raw ? sanitize(JSON.parse(raw)) : {}
      set({ bySlot, loaded: true })
    } catch {
      set({ bySlot: {}, loaded: true })
    }
  },

  save: async (slot, fav) => {
    if (!isValid(slot)) return
    const bySlot = { ...get().bySlot, [slot]: fav }
    set({ bySlot })
    await persist(bySlot)
  },

  clear: async (slot) => {
    const bySlot = { ...get().bySlot }
    delete bySlot[slot]
    set({ bySlot })
    await persist(bySlot)
  },
}))
