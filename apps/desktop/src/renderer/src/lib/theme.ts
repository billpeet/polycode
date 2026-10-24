import { create } from 'zustand'
import {
  ACCENT_SETTING_KEY,
  DEFAULT_CATPPUCCIN_ACCENT,
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  DEFAULT_TERMINAL_FONT,
  DEFAULT_THEME_ID,
  MONO_FONT_SETTING_KEY,
  SANS_FONT_SETTING_KEY,
  THEME_SETTING_KEY,
  isCatppuccinAccent,
  isThemeId,
  resolveTheme,
  toFontStack,
  type CatppuccinAccent,
  type ColorToken,
  type TerminalPalette,
  type Theme,
  type ThemeId,
} from '../../../shared/themes'
import { getPref, setPref } from './prefs'

/**
 * The active appearance: a theme (plus its accent, for Catppuccin) and optional font
 * overrides. It is a UI preference — this client's look — so it goes through `prefs`.
 *
 * Applying it writes the theme's tokens as inline custom properties on <html>, which
 * beat the defaults declared in index.css. Surfaces that do not read CSS (xterm, shiki,
 * @pierre/diffs) subscribe to this store instead.
 *
 * The last applied choice is mirrored to localStorage so `applyCachedAppearance()` can
 * paint it synchronously at startup, before the async `settings:get` round trip.
 */

export interface AppearanceChoice {
  themeId: ThemeId
  accent: CatppuccinAccent
  /** The user's font list as typed; empty for the theme default. */
  fontSans: string
  fontMono: string
}

interface AppearanceState extends AppearanceChoice {
  theme: Theme
  setThemeId: (id: ThemeId) => void
  setAccent: (accent: CatppuccinAccent) => void
  setFontSans: (font: string) => void
  setFontMono: (font: string) => void
  /** Read the persisted choice and apply it. */
  load: () => Promise<void>
}

const CACHE_KEY = 'polycode:appearance'

const DEFAULT_CHOICE: AppearanceChoice = {
  themeId: DEFAULT_THEME_ID,
  accent: DEFAULT_CATPPUCCIN_ACCENT,
  fontSans: '',
  fontMono: '',
}

function normalise(raw: Partial<Record<keyof AppearanceChoice, unknown>>): AppearanceChoice {
  return {
    themeId: isThemeId(raw.themeId) ? raw.themeId : DEFAULT_CHOICE.themeId,
    accent: isCatppuccinAccent(raw.accent) ? raw.accent : DEFAULT_CHOICE.accent,
    fontSans: typeof raw.fontSans === 'string' ? raw.fontSans : '',
    fontMono: typeof raw.fontMono === 'string' ? raw.fontMono : '',
  }
}

function readCache(): AppearanceChoice {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? normalise(JSON.parse(raw) as Record<string, unknown>) : DEFAULT_CHOICE
  } catch {
    return DEFAULT_CHOICE
  }
}

function writeCache(choice: AppearanceChoice): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(choice))
  } catch {
    // Storage full or unavailable: startup will briefly show the default theme.
  }
}

export function applyAppearance(choice: AppearanceChoice, theme: Theme = resolveTheme(choice.themeId, choice.accent)): void {
  const style = document.documentElement.style
  for (const [token, value] of Object.entries(theme.colors) as Array<[ColorToken, string]>) {
    style.setProperty(`--color-${token}`, value)
  }
  style.setProperty('--font-sans', toFontStack(choice.fontSans, 'sans-serif') ?? DEFAULT_SANS_FONT)
  style.setProperty('--font-mono', toFontStack(choice.fontMono, 'monospace') ?? DEFAULT_MONO_FONT)
  document.documentElement.dataset.theme = theme.id
}

/** Paint the last-used appearance before React mounts. */
export function applyCachedAppearance(): void {
  const choice = readCache()
  useAppearance.setState({ ...choice, theme: resolveTheme(choice.themeId, choice.accent) })
  applyAppearance(choice)
}

function commit(next: AppearanceChoice): Partial<AppearanceState> {
  const theme = resolveTheme(next.themeId, next.accent)
  applyAppearance(next, theme)
  writeCache(next)
  return { ...next, theme }
}

function choiceOf(state: AppearanceState): AppearanceChoice {
  return { themeId: state.themeId, accent: state.accent, fontSans: state.fontSans, fontMono: state.fontMono }
}

function persist(key: Parameters<typeof setPref>[0], value: string): void {
  void setPref(key, value).catch((error: unknown) => console.error(`[appearance] Failed to save ${key}`, error))
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...DEFAULT_CHOICE,
  theme: resolveTheme(DEFAULT_CHOICE.themeId),

  setThemeId: (themeId) => {
    set(commit({ ...choiceOf(get()), themeId }))
    persist(THEME_SETTING_KEY, themeId)
  },
  setAccent: (accent) => {
    set(commit({ ...choiceOf(get()), accent }))
    persist(ACCENT_SETTING_KEY, accent)
  },
  setFontSans: (fontSans) => {
    set(commit({ ...choiceOf(get()), fontSans }))
    persist(SANS_FONT_SETTING_KEY, fontSans)
  },
  setFontMono: (fontMono) => {
    set(commit({ ...choiceOf(get()), fontMono }))
    persist(MONO_FONT_SETTING_KEY, fontMono)
  },

  load: async () => {
    try {
      const [themeId, accent, fontSans, fontMono] = await Promise.all([
        getPref(THEME_SETTING_KEY),
        getPref(ACCENT_SETTING_KEY),
        getPref(SANS_FONT_SETTING_KEY),
        getPref(MONO_FONT_SETTING_KEY),
      ])
      set(commit(normalise({ themeId, accent, fontSans, fontMono })))
    } catch (error) {
      console.error('[appearance] Failed to load appearance', error)
    }
  },
}))

/** The palette and font for an xterm instance. */
export function terminalAppearance(state: Pick<AppearanceState, 'theme' | 'fontMono'>): {
  theme: TerminalPalette
  fontFamily: string
} {
  return {
    theme: state.theme.terminal,
    fontFamily: toFontStack(state.fontMono, 'monospace') ?? DEFAULT_TERMINAL_FONT,
  }
}

/** The shiki theme for code blocks and file previews. */
export function useSyntaxTheme(): Theme['syntaxTheme'] {
  return useAppearance((s) => s.theme.syntaxTheme)
}

export function getSyntaxTheme(): Theme['syntaxTheme'] {
  return useAppearance.getState().theme.syntaxTheme
}

export function useDiffTheme(): string {
  return useAppearance((s) => s.theme.diffTheme)
}
