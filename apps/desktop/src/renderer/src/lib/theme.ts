import { create } from 'zustand'
import {
  ACCENT_SETTING_KEY,
  CUSTOM_THEMES_SETTING_KEY,
  DEFAULT_CATPPUCCIN_ACCENT,
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  DEFAULT_TERMINAL_FONT,
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  MONO_FONT_SETTING_KEY,
  PRELOADED_SYNTAX_THEMES,
  SANS_FONT_SETTING_KEY,
  THEME_NAMES,
  THEME_SETTING_KEY,
  importCustomTheme,
  isBuiltinThemeId,
  isCatppuccinAccent,
  isCustomThemeId,
  isThemeColor,
  isThemeId,
  newCustomThemeId,
  parseCustomThemes,
  resolveTheme,
  themeHasAccent,
  toFontStack,
  type CatppuccinAccent,
  type ColorToken,
  type CustomTheme,
  type CustomThemeId,
  type ImportResult,
  type SyntaxTheme,
  type TerminalPalette,
  type Theme,
  type ThemeId,
} from '../../../shared/themes'
import { getPref, setPref } from './prefs'
import { isSyntaxThemeLoaded, loadSyntaxTheme } from './shiki'

/**
 * The active appearance: a theme (plus its accent, for Catppuccin), the user's custom
 * themes, and optional font overrides. It is a UI preference — this client's look — so
 * it goes through `prefs`.
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
  customThemes: CustomTheme[]
}

/** The editable parts of a custom theme. */
export type CustomThemePatch = Partial<Pick<CustomTheme, 'name' | 'base' | 'accent' | 'syntaxTheme'>>

interface AppearanceState extends AppearanceChoice {
  theme: Theme
  /**
   * The syntax palette code is highlighted with: the theme's, once the highlighter has
   * it. Until then the previous one stays, rather than code rendering unhighlighted.
   */
  syntaxTheme: SyntaxTheme
  setThemeId: (id: ThemeId) => void
  setAccent: (accent: CatppuccinAccent) => void
  setFontSans: (font: string) => void
  setFontMono: (font: string) => void
  /** Create a custom theme from the active one, make it active, and return its id (null at the limit). */
  createCustomTheme: () => CustomThemeId | null
  updateCustomTheme: (id: CustomThemeId, patch: CustomThemePatch) => void
  /** Set (or with null, reset to the base theme's) one colour token. Invalid colours are ignored. */
  setCustomColor: (id: CustomThemeId, token: ColorToken, value: string | null) => void
  setCustomTerminalColor: (id: CustomThemeId, key: keyof TerminalPalette, value: string | null) => void
  deleteCustomTheme: (id: CustomThemeId) => void
  /** Add a theme from its shared JSON and make it active. */
  importCustomTheme: (json: string) => ImportResult
  /** Read the persisted choice and apply it. */
  load: () => Promise<void>
}

const CACHE_KEY = 'polycode:appearance'

const DEFAULT_CHOICE: AppearanceChoice = {
  themeId: DEFAULT_THEME_ID,
  accent: DEFAULT_CATPPUCCIN_ACCENT,
  fontSans: '',
  fontMono: '',
  customThemes: [],
}

function normalise(raw: Partial<Record<keyof AppearanceChoice, unknown>>): AppearanceChoice {
  return {
    themeId: isThemeId(raw.themeId) ? raw.themeId : DEFAULT_CHOICE.themeId,
    accent: isCatppuccinAccent(raw.accent) ? raw.accent : DEFAULT_CHOICE.accent,
    fontSans: typeof raw.fontSans === 'string' ? raw.fontSans : '',
    fontMono: typeof raw.fontMono === 'string' ? raw.fontMono : '',
    customThemes: parseCustomThemes(
      typeof raw.customThemes === 'string' ? raw.customThemes : JSON.stringify(raw.customThemes ?? []),
    ),
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

function resolveChoice(choice: AppearanceChoice): Theme {
  return resolveTheme(choice.themeId, choice.accent, choice.customThemes)
}

export function applyAppearance(choice: AppearanceChoice, theme: Theme = resolveChoice(choice)): void {
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
  const theme = resolveChoice(choice)
  // Only a preloaded palette is safe before the highlighter has loaded anything else.
  const syntaxTheme = (PRELOADED_SYNTAX_THEMES as readonly string[]).includes(theme.syntaxTheme)
    ? theme.syntaxTheme
    : resolveTheme(DEFAULT_THEME_ID).syntaxTheme
  useAppearance.setState({ ...choice, theme, syntaxTheme })
  applyAppearance(choice, theme)
  ensureSyntaxTheme(theme.syntaxTheme)
}

/** Switch code highlighting to `wanted` once the highlighter has it. */
function ensureSyntaxTheme(wanted: SyntaxTheme): void {
  if (isSyntaxThemeLoaded(wanted)) {
    useAppearance.setState({ syntaxTheme: wanted })
    return
  }
  void loadSyntaxTheme(wanted).then(
    () => {
      // Only if the user has not moved on to another theme meanwhile.
      if (useAppearance.getState().theme.syntaxTheme === wanted) useAppearance.setState({ syntaxTheme: wanted })
    },
    (error: unknown) => console.error(`[appearance] Failed to load syntax theme ${wanted}`, error),
  )
}

function commit(next: AppearanceChoice): Partial<AppearanceState> {
  const theme = resolveChoice(next)
  applyAppearance(next, theme)
  writeCache(next)
  ensureSyntaxTheme(theme.syntaxTheme)
  return { ...next, theme }
}

function choiceOf(state: AppearanceState): AppearanceChoice {
  return {
    themeId: state.themeId,
    accent: state.accent,
    fontSans: state.fontSans,
    fontMono: state.fontMono,
    customThemes: state.customThemes,
  }
}

function persist(key: Parameters<typeof setPref>[0], value: string): void {
  void setPref(key, value).catch((error: unknown) => console.error(`[appearance] Failed to save ${key}`, error))
}

// A colour picker emits a change per pointer move; write the list once it settles.
let customThemesTimer: ReturnType<typeof setTimeout> | undefined
function persistCustomThemes(themes: CustomTheme[]): void {
  clearTimeout(customThemesTimer)
  customThemesTimer = setTimeout(() => persist(CUSTOM_THEMES_SETTING_KEY, JSON.stringify(themes)), 300)
}

function withoutKey<T extends object>(record: T, key: keyof T): T {
  const next = { ...record }
  delete next[key]
  return next
}

export const useAppearance = create<AppearanceState>((set, get) => {
  /** Replace one custom theme, re-applying it if it is the active one. */
  function updateTheme(id: CustomThemeId, update: (theme: CustomTheme) => CustomTheme): void {
    const state = get()
    const customThemes = state.customThemes.map((t) => (t.id === id ? update(t) : t))
    set(commit({ ...choiceOf(state), customThemes }))
    persistCustomThemes(customThemes)
  }

  function addAndActivate(theme: CustomTheme): void {
    const customThemes = [...get().customThemes, theme]
    set(commit({ ...choiceOf(get()), customThemes, themeId: theme.id }))
    persistCustomThemes(customThemes)
    persist(THEME_SETTING_KEY, theme.id)
  }

  return {
    ...DEFAULT_CHOICE,
    theme: resolveTheme(DEFAULT_CHOICE.themeId),
    syntaxTheme: resolveTheme(DEFAULT_CHOICE.themeId).syntaxTheme,

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

    createCustomTheme: () => {
      const state = get()
      if (state.customThemes.length >= MAX_CUSTOM_THEMES) return null
      const id = newCustomThemeId()
      const current = state.customThemes.find((t) => t.id === state.themeId)
      const theme: CustomTheme = current
        ? { ...current, id, name: `Copy of ${current.name}` }
        : (() => {
          const base = isBuiltinThemeId(state.themeId) ? state.themeId : DEFAULT_THEME_ID
          return {
            id,
            name: `My ${THEME_NAMES[base]}`,
            base,
            ...(themeHasAccent(base) ? { accent: state.accent } : {}),
            colors: {},
            terminal: {},
          }
        })()
      addAndActivate(theme)
      return id
    },

    updateCustomTheme: (id, patch) => updateTheme(id, (theme) => {
      const next = { ...theme, ...patch }
      if (patch.syntaxTheme === undefined && 'syntaxTheme' in patch) delete next.syntaxTheme
      // An accent only means something on a Catppuccin base.
      if (!themeHasAccent(next.base)) delete next.accent
      else if (!next.accent) next.accent = DEFAULT_CATPPUCCIN_ACCENT
      return next
    }),

    setCustomColor: (id, token, value) => {
      if (value !== null && !isThemeColor(value)) return
      updateTheme(id, (theme) => ({
        ...theme,
        colors: value === null ? withoutKey(theme.colors, token) : { ...theme.colors, [token]: value.trim() },
      }))
    },

    setCustomTerminalColor: (id, key, value) => {
      if (value !== null && !isThemeColor(value)) return
      updateTheme(id, (theme) => ({
        ...theme,
        terminal: value === null ? withoutKey(theme.terminal, key) : { ...theme.terminal, [key]: value.trim() },
      }))
    },

    deleteCustomTheme: (id) => {
      const state = get()
      const deleted = state.customThemes.find((t) => t.id === id)
      if (!deleted) return
      const customThemes = state.customThemes.filter((t) => t.id !== id)
      // Deleting the active theme falls back to what it was built on.
      const themeId = state.themeId === id ? deleted.base : state.themeId
      const accent = state.themeId === id && deleted.accent ? deleted.accent : state.accent
      set(commit({ ...choiceOf(state), customThemes, themeId, accent }))
      persistCustomThemes(customThemes)
      if (themeId !== state.themeId) persist(THEME_SETTING_KEY, themeId)
      if (accent !== state.accent) persist(ACCENT_SETTING_KEY, accent)
    },

    importCustomTheme: (json) => {
      if (get().customThemes.length >= MAX_CUSTOM_THEMES) {
        return { ok: false, error: `You already have ${MAX_CUSTOM_THEMES} custom themes; delete one first.` }
      }
      const result = importCustomTheme(json, newCustomThemeId())
      if (result.ok) addAndActivate(result.theme)
      return result
    },

    load: async () => {
      try {
        const [themeId, accent, fontSans, fontMono, customThemes] = await Promise.all([
          getPref(THEME_SETTING_KEY),
          getPref(ACCENT_SETTING_KEY),
          getPref(SANS_FONT_SETTING_KEY),
          getPref(MONO_FONT_SETTING_KEY),
          getPref(CUSTOM_THEMES_SETTING_KEY),
        ])
        set(commit(normalise({ themeId, accent, fontSans, fontMono, customThemes })))
      } catch (error) {
        console.error('[appearance] Failed to load appearance', error)
      }
    },
  }
})

/** The active custom theme, or undefined when a built-in theme is active. */
export function useActiveCustomTheme(): CustomTheme | undefined {
  return useAppearance((s) => (isCustomThemeId(s.themeId) ? s.customThemes.find((t) => t.id === s.themeId) : undefined))
}

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
export function useSyntaxTheme(): SyntaxTheme {
  return useAppearance((s) => s.syntaxTheme)
}

export function getSyntaxTheme(): SyntaxTheme {
  return useAppearance.getState().syntaxTheme
}

export function useDiffTheme(): string {
  return useAppearance((s) => s.theme.diffTheme)
}
