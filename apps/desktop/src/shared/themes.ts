/**
 * Colour themes for the desktop renderer (and the Web Client, which is the same renderer).
 *
 * A theme is a set of values for the `--color-*` custom properties declared in
 * `renderer/src/index.css`, plus the palettes of the few surfaces that do not read CSS:
 * the xterm terminals, shiki code highlighting and `@pierre/diffs`. The main process
 * reads `bg` too, so the window opens in the theme's colour instead of flashing.
 *
 * Every theme is dark. Several surfaces lay translucent white over the background for
 * hover and selection, which only reads on a dark base, so a light theme would need
 * those reworked first.
 */

/** The semantic colour tokens. Each becomes a `--color-<token>` custom property. */
export interface ThemeColors {
  /** The window background; the darkest layer. */
  bg: string
  /** Panels and cards raised above `bg`. */
  surface: string
  /** Inputs, dialogs and hover states raised above `surface`. */
  'surface-2': string
  border: string
  text: string
  'text-muted': string
  /** Headings and other text that should stand out from body text. */
  'text-strong': string
  /** The brand / interactive colour: primary buttons, links, focus, pending state. */
  accent: string
  /** A deeper accent: gradient ends and pressed states. */
  'accent-strong': string
  /** Text and icons drawn on a solid fill of accent or any status `-strong` colour. */
  'on-accent': string
  'inline-code': string
  'code-bg': string
  'code-header': string
  /** Errors, destructive actions, deletions. */
  danger: string
  /** Solid fills for destructive buttons and error toasts. */
  'danger-strong': string
  /** Success, running, additions. */
  success: string
  'success-strong': string
  /** Warnings, stopped state, untracked files. */
  warning: string
  'warning-strong': string
  /** Informational: SSH locations, file mentions, modified files. */
  info: string
  'info-strong': string
  /** Plan mode, thinking, renames. */
  purple: string
  'purple-strong': string
  /** Stopping state, fast mode, YOLO permissions. */
  orange: string
  /** Folders and git modifications. */
  gold: string
}

export type ColorToken = keyof ThemeColors

/** xterm's `ITheme`, restated so this module has no renderer dependencies. */
export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: ThemeId
  name: string
  colors: ThemeColors
  terminal: TerminalPalette
  /** Foreground for command log output, which is quieter than an interactive terminal. */
  logForeground: string
  /** A shiki bundled theme name, used for markdown code blocks and file previews. */
  syntaxTheme: SyntaxTheme
  /** A theme name `@pierre/diffs` accepts (its own, or any shiki bundled theme). */
  diffTheme: string
}

/** The built-in themes' syntax palettes, loaded with the highlighter so switching between them is instant. */
export const PRELOADED_SYNTAX_THEMES = ['github-dark', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe'] as const

/**
 * Every syntax palette a custom theme may pick: shiki bundled dark themes, which
 * `@pierre/diffs` also accepts. Those not preloaded are loaded on first use.
 */
export const SYNTAX_THEMES = [
  ...PRELOADED_SYNTAX_THEMES,
  'github-dark-dimmed', 'github-dark-default', 'one-dark-pro', 'dracula', 'nord', 'tokyo-night',
  'gruvbox-dark-medium', 'rose-pine', 'rose-pine-moon', 'kanagawa-wave', 'everforest-dark',
  'solarized-dark', 'monokai', 'night-owl', 'vitesse-dark', 'material-theme-darker', 'ayu-dark',
  'poimandres', 'houston', 'synthwave-84',
] as const
export type SyntaxTheme = typeof SYNTAX_THEMES[number]

export function isSyntaxTheme(value: unknown): value is SyntaxTheme {
  return typeof value === 'string' && (SYNTAX_THEMES as readonly string[]).includes(value)
}

// ── PolyCode Dark ───────────────────────────────────────────────────────────

const polycodeDark: Theme = {
  id: 'polycode-dark',
  name: 'PolyCode Dark',
  colors: {
    bg: '#0f0f0f',
    surface: '#1a1a1a',
    'surface-2': '#222222',
    border: '#2a2a2a',
    text: '#e8e8e8',
    'text-muted': '#888888',
    'text-strong': '#f0f0f0',
    accent: '#e87b5f',
    'accent-strong': '#d06a50',
    'on-accent': '#ffffff',
    'inline-code': '#e2a97e',
    'code-bg': '#0d1117',
    'code-header': '#161616',
    danger: '#f87171',
    'danger-strong': '#dc2626',
    success: '#4ade80',
    'success-strong': '#16a34a',
    warning: '#fbbf24',
    'warning-strong': '#d97706',
    info: '#63b3ed',
    'info-strong': '#4299e1',
    purple: '#a78bfa',
    'purple-strong': '#9333ea',
    orange: '#fb923c',
    gold: '#e8b86d',
  },
  terminal: {
    background: '#0f0f0f',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    selectionBackground: 'rgba(180, 203, 255, 0.25)',
    black: '#1e1e1e',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#facc15',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#d4d4d4',
    brightBlack: '#6b7280',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f9fafb',
  },
  logForeground: '#a1a1aa',
  syntaxTheme: 'github-dark',
  diffTheme: 'pierre-dark',
}

// ── Catppuccin ──────────────────────────────────────────────────────────────
// Palettes from https://catppuccin.com/palette. Latte (the light flavour) is left out;
// see the note at the top of this file.

interface CatppuccinPalette {
  rosewater: string; flamingo: string; pink: string; mauve: string; red: string; maroon: string
  peach: string; yellow: string; green: string; teal: string; sky: string; sapphire: string
  blue: string; lavender: string; text: string; subtext1: string; subtext0: string
  overlay2: string; overlay1: string; overlay0: string; surface2: string; surface1: string
  surface0: string; base: string; mantle: string; crust: string
}

export const CATPPUCCIN_ACCENTS = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach',
  'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender',
] as const
export type CatppuccinAccent = typeof CATPPUCCIN_ACCENTS[number]
export const DEFAULT_CATPPUCCIN_ACCENT: CatppuccinAccent = 'mauve'

const CATPPUCCIN_FLAVOURS = {
  mocha: {
    rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8',
    maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5',
    sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe', text: '#cdd6f4',
    subtext1: '#bac2de', subtext0: '#a6adc8', overlay2: '#9399b2', overlay1: '#7f849c',
    overlay0: '#6c7086', surface2: '#585b70', surface1: '#45475a', surface0: '#313244',
    base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
  },
  macchiato: {
    rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6', red: '#ed8796',
    maroon: '#ee99a0', peach: '#f5a97f', yellow: '#eed49f', green: '#a6da95', teal: '#8bd5ca',
    sky: '#91d7e3', sapphire: '#7dc4e4', blue: '#8aadf4', lavender: '#b7bdf8', text: '#cad3f5',
    subtext1: '#b8c0e0', subtext0: '#a5adcb', overlay2: '#939ab7', overlay1: '#8087a2',
    overlay0: '#6e738d', surface2: '#5b6078', surface1: '#494d64', surface0: '#363a4f',
    base: '#24273a', mantle: '#1e2030', crust: '#181926',
  },
  frappe: {
    rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6', red: '#e78284',
    maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890', green: '#a6d189', teal: '#81c8be',
    sky: '#99d1db', sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1', text: '#c6d0f5',
    subtext1: '#b5bfe2', subtext0: '#a5adce', overlay2: '#949cbb', overlay1: '#838ba7',
    overlay0: '#737994', surface2: '#626880', surface1: '#51576d', surface0: '#414559',
    base: '#303446', mantle: '#292c3c', crust: '#232634',
  },
} satisfies Record<string, CatppuccinPalette>

type CatppuccinFlavour = keyof typeof CATPPUCCIN_FLAVOURS

const FLAVOUR_NAMES: Record<CatppuccinFlavour, string> = {
  mocha: 'Catppuccin Mocha',
  macchiato: 'Catppuccin Macchiato',
  frappe: 'Catppuccin Frappé',
}

/** Darken a palette colour toward the flavour's crust, for gradient ends. */
function deepen(color: string, crust: string): string {
  return `color-mix(in srgb, ${color} 80%, ${crust})`
}

function catppuccin(flavour: CatppuccinFlavour, accent: CatppuccinAccent): Theme {
  const p: CatppuccinPalette = CATPPUCCIN_FLAVOURS[flavour]
  // Plan mode and thinking are purple; keep them distinct from a mauve accent.
  const purple = accent === 'mauve' ? p.lavender : p.mauve
  return {
    id: `catppuccin-${flavour}`,
    name: FLAVOUR_NAMES[flavour],
    colors: {
      bg: p.crust,
      surface: p.mantle,
      'surface-2': p.base,
      border: p.surface0,
      text: p.text,
      'text-muted': p.overlay2,
      'text-strong': p.text,
      accent: p[accent],
      'accent-strong': deepen(p[accent], p.crust),
      'on-accent': p.crust,
      'inline-code': p.peach,
      'code-bg': p.crust,
      'code-header': p.mantle,
      danger: p.red,
      'danger-strong': p.red,
      success: p.green,
      'success-strong': p.green,
      warning: p.yellow,
      'warning-strong': p.peach,
      info: p.blue,
      'info-strong': p.sapphire,
      purple,
      'purple-strong': deepen(purple, p.crust),
      orange: p.peach,
      gold: p.yellow,
    },
    // After https://github.com/catppuccin/alacritty and catppuccin/kitty.
    terminal: {
      background: p.crust,
      foreground: p.text,
      cursor: p.rosewater,
      selectionBackground: `${p.overlay2}4d`,
      black: p.surface1,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.pink,
      cyan: p.teal,
      white: p.subtext1,
      brightBlack: p.surface2,
      brightRed: p.red,
      brightGreen: p.green,
      brightYellow: p.yellow,
      brightBlue: p.blue,
      brightMagenta: p.pink,
      brightCyan: p.teal,
      brightWhite: p.subtext0,
    },
    logForeground: p.subtext0,
    syntaxTheme: `catppuccin-${flavour}`,
    diffTheme: `catppuccin-${flavour}`,
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

export const BUILTIN_THEME_IDS = ['polycode-dark', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe'] as const
export type BuiltinThemeId = typeof BUILTIN_THEME_IDS[number]
export type CustomThemeId = `custom:${string}`
export type ThemeId = BuiltinThemeId | CustomThemeId
export const DEFAULT_THEME_ID: BuiltinThemeId = 'polycode-dark'

export const THEME_NAMES: Record<BuiltinThemeId, string> = {
  'polycode-dark': polycodeDark.name,
  'catppuccin-mocha': FLAVOUR_NAMES.mocha,
  'catppuccin-macchiato': FLAVOUR_NAMES.macchiato,
  'catppuccin-frappe': FLAVOUR_NAMES.frappe,
}

export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return typeof value === 'string' && (BUILTIN_THEME_IDS as readonly string[]).includes(value)
}

export function isCustomThemeId(value: unknown): value is CustomThemeId {
  return typeof value === 'string' && /^custom:[\w-]{1,64}$/.test(value)
}

/** A well-formed id. A custom id may still name a theme that has since been deleted. */
export function isThemeId(value: unknown): value is ThemeId {
  return isBuiltinThemeId(value) || isCustomThemeId(value)
}

export function isCatppuccinAccent(value: unknown): value is CatppuccinAccent {
  return typeof value === 'string' && (CATPPUCCIN_ACCENTS as readonly string[]).includes(value)
}

/** True for built-in themes that take a `CatppuccinAccent`. */
export function themeHasAccent(id: BuiltinThemeId): boolean {
  return id.startsWith('catppuccin-')
}

function resolveBuiltinTheme(id: BuiltinThemeId, accent: CatppuccinAccent): Theme {
  switch (id) {
    case 'catppuccin-mocha': return catppuccin('mocha', accent)
    case 'catppuccin-macchiato': return catppuccin('macchiato', accent)
    case 'catppuccin-frappe': return catppuccin('frappe', accent)
    case 'polycode-dark': return polycodeDark
  }
}

/**
 * Resolve a stored theme id to a theme. Built-in Catppuccin themes take `accent`; a
 * custom theme is its base theme with its own overrides laid over it. Unknown or
 * deleted ids fall back to the default.
 */
export function resolveTheme(id: unknown, accent?: unknown, customThemes: readonly CustomTheme[] = []): Theme {
  const catAccent = isCatppuccinAccent(accent) ? accent : DEFAULT_CATPPUCCIN_ACCENT
  if (isCustomThemeId(id)) {
    const custom = customThemes.find((t) => t.id === id)
    if (custom) return applyCustomTheme(custom)
  }
  return resolveBuiltinTheme(isBuiltinThemeId(id) ? id : DEFAULT_THEME_ID, catAccent)
}

/** A swatch for the accent picker. */
export function catppuccinAccentColor(id: BuiltinThemeId, accent: CatppuccinAccent): string {
  const flavour = id.replace('catppuccin-', '') as CatppuccinFlavour
  return (CATPPUCCIN_FLAVOURS[flavour] ?? CATPPUCCIN_FLAVOURS.mocha)[accent]
}

// ── Custom themes ───────────────────────────────────────────────────────────
//
// A custom theme stores only what it changes. Everything else comes from its base
// built-in theme, so a theme made today keeps working when a token is added later:
// the new token simply takes the base theme's value.

export interface CustomTheme {
  id: CustomThemeId
  name: string
  base: BuiltinThemeId
  /** The base theme's accent, for Catppuccin bases. */
  accent?: CatppuccinAccent
  colors: Partial<ThemeColors>
  terminal: Partial<TerminalPalette>
  /** Overrides the base theme's syntax palette, for code blocks and diffs alike. */
  syntaxTheme?: SyntaxTheme
}

export const MAX_CUSTOM_THEMES = 50
export const MAX_THEME_NAME_LENGTH = 60

export const COLOR_TOKENS: readonly ColorToken[] = Object.keys(polycodeDark.colors) as ColorToken[]
export const TERMINAL_KEYS: readonly (keyof TerminalPalette)[] = Object.keys(polycodeDark.terminal) as (keyof TerminalPalette)[]

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTIONAL_COLOR = /^(?:rgba?|hsla?)\(\s*[\d.]+(?:deg|%)?(?:\s*[,\s/]\s*[\d.]+%?){2,3}\s*\)$/i

/**
 * A colour a user may put in a theme: hex, or numeric rgb()/hsl(). Values become CSS
 * custom properties and inline styles, so anything else — `var()`, `url()`, keywords,
 * a stray `;` — is refused rather than escaped.
 */
export function isThemeColor(value: unknown): value is string {
  return typeof value === 'string' && (HEX_COLOR.test(value.trim()) || FUNCTIONAL_COLOR.test(value.trim()))
}

/** Electron's window background takes hex only, and reads 8-digit hex as #AARRGGBB. */
export function isOpaqueHex(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

export function applyCustomTheme(custom: CustomTheme): Theme {
  const base = resolveBuiltinTheme(custom.base, custom.accent ?? DEFAULT_CATPPUCCIN_ACCENT)
  const colors = { ...base.colors, ...custom.colors }
  const terminal = { ...base.terminal, ...custom.terminal }
  // A changed background carries into the terminals unless they were set explicitly.
  if (custom.colors.bg && !custom.terminal.background) terminal.background = custom.colors.bg
  return {
    ...base,
    id: custom.id,
    name: custom.name,
    colors,
    terminal,
    syntaxTheme: custom.syntaxTheme ?? base.syntaxTheme,
    diffTheme: custom.syntaxTheme ?? base.diffTheme,
  }
}

function pickColors<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key]
    if (isThemeColor(value)) out[key] = value.trim()
  }
  return out
}

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_THEME_NAME_LENGTH) : ''
  return name || 'Untitled theme'
}

/**
 * Validate one stored or imported theme. Unknown fields and invalid colours are
 * dropped, so a hand-edited or newer theme still loads with whatever it got right.
 * Returns null only when there is nothing usable (no object, or no valid base).
 */
export function parseCustomTheme(raw: unknown, id?: CustomThemeId): CustomTheme | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const themeId = id ?? (isCustomThemeId(r.id) ? r.id : null)
  if (!themeId || !isBuiltinThemeId(r.base)) return null
  return {
    id: themeId,
    name: cleanName(r.name),
    base: r.base,
    ...(isCatppuccinAccent(r.accent) ? { accent: r.accent } : {}),
    colors: pickColors(r.colors, COLOR_TOKENS),
    terminal: pickColors(r.terminal, TERMINAL_KEYS),
    ...(isSyntaxTheme(r.syntaxTheme) ? { syntaxTheme: r.syntaxTheme } : {}),
  }
}

/** Parse the persisted list, dropping invalid entries and duplicate ids. */
export function parseCustomThemes(json: string | null | undefined): CustomTheme[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const themes: CustomTheme[] = []
  for (const entry of raw.slice(0, MAX_CUSTOM_THEMES)) {
    const theme = parseCustomTheme(entry)
    if (theme && !seen.has(theme.id)) {
      seen.add(theme.id)
      themes.push(theme)
    }
  }
  return themes
}

// The shareable form: no id (the importer assigns one), and a marker so arbitrary JSON
// is not mistaken for a theme.
export const THEME_FILE_VERSION = 1

export function exportCustomTheme(theme: CustomTheme): string {
  const { id: _id, ...rest } = theme
  void _id
  return JSON.stringify({ polycodeTheme: THEME_FILE_VERSION, ...rest }, null, 2)
}

export type ImportResult = { ok: true; theme: CustomTheme } | { ok: false; error: string }

export function importCustomTheme(text: string, id: CustomThemeId): ImportResult {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, error: 'That is not valid JSON.' } }
  if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).polycodeTheme === undefined) {
    return { ok: false, error: 'That JSON is not a PolyCode theme (it has no "polycodeTheme" field).' }
  }
  const version = (raw as Record<string, unknown>).polycodeTheme
  if (typeof version !== 'number' || version > THEME_FILE_VERSION) {
    return { ok: false, error: 'This theme was made by a newer version of PolyCode.' }
  }
  const theme = parseCustomTheme(raw, id)
  if (!theme) {
    return { ok: false, error: `The theme needs a "base" of ${BUILTIN_THEME_IDS.map((b) => `"${b}"`).join(', ')}.` }
  }
  return { ok: true, theme }
}

/** A fresh, unguessable-enough id for a new custom theme. */
export function newCustomThemeId(): CustomThemeId {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `custom:${random}`
}

// ── Fonts ───────────────────────────────────────────────────────────────────

export const DEFAULT_SANS_FONT = 'system-ui, -apple-system, sans-serif'
export const DEFAULT_MONO_FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', 'Consolas', monospace"
/** The terminals have always used their own stack; kept unless the user picks a mono font. */
export const DEFAULT_TERMINAL_FONT = 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace'

/**
 * Turn a user-entered font list into a CSS `font-family` value with a generic fallback.
 * Bare family names containing spaces are quoted; anything that could break out of the
 * declaration is dropped, since the value ends up in a custom property.
 */
export function toFontStack(input: string | null | undefined, fallback: 'sans-serif' | 'monospace'): string | null {
  if (!input) return null
  const families = input
    .split(',')
    .map((f) => f.trim().replace(/[;{}()<>\\]/g, ''))
    .filter(Boolean)
    .map((f) => (/^["'].*["']$/.test(f) || !/\s/.test(f) ? f : `'${f.replace(/'/g, '')}'`))
  if (families.length === 0) return null
  return [...families, fallback].join(', ')
}

// ── Persistence keys ────────────────────────────────────────────────────────

export const THEME_SETTING_KEY = 'appearance:theme'
export const ACCENT_SETTING_KEY = 'appearance:accent'
export const SANS_FONT_SETTING_KEY = 'appearance:fontSans'
export const MONO_FONT_SETTING_KEY = 'appearance:fontMono'
export const CUSTOM_THEMES_SETTING_KEY = 'appearance:customThemes'
