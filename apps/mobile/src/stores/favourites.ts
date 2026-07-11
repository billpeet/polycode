import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  getModelsForProvider,
  PROVIDERS,
  type Provider,
  type ReasoningLevel,
} from '@polycode/shared'

/** A saved provider/model/effort combination (desktop favourites parity). */
export interface Favourite {
  provider: Provider
  model: string
  reasoningLevel: ReasoningLevel
}

export const MAX_FAVOURITES = 6

/** Short chip label, e.g. "Opus 4.8 · max". */
export function favouriteChipLabel(fav: Favourite): string {
  const model = getModelsForProvider(fav.provider).find((m) => m.id === fav.model)?.label ?? fav.model
  return fav.reasoningLevel !== 'off' ? `${model} · ${fav.reasoningLevel}` : model
}

/** Full label, e.g. "Claude Code · Opus 4.8 · max". */
export function formatFavourite(fav: Favourite): string {
  const provider = PROVIDERS.find((p) => p.id === fav.provider)?.label ?? fav.provider
  return `${provider} · ${favouriteChipLabel(fav)}`
}

export function favouriteEquals(a: Favourite, b: Favourite): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningLevel === b.reasoningLevel
}

interface FavouritesState {
  favourites: Favourite[]
  add: (fav: Favourite) => void
  removeAt: (index: number) => void
}

export const useFavouritesStore = create<FavouritesState>()(
  persist(
    (set) => ({
      favourites: [],

      add: (fav) =>
        set((s) => {
          if (s.favourites.some((existing) => favouriteEquals(existing, fav))) return s
          return { favourites: [...s.favourites, fav].slice(-MAX_FAVOURITES) }
        }),

      removeAt: (index) =>
        set((s) => ({ favourites: s.favourites.filter((_, i) => i !== index) })),
    }),
    {
      name: 'polycode.favourites',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)
