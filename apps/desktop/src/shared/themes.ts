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

export const SYNTAX_THEMES = ['github-dark', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe'] as const
export type SyntaxTheme = typeof SYNTAX_THEMES[number]

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

export const THEME_IDS = ['polycode-dark', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe'] as const
export type ThemeId = typeof THEME_IDS[number]
export const DEFAULT_THEME_ID: ThemeId = 'polycode-dark'

export const THEME_NAMES: Record<ThemeId, string> = {
  'polycode-dark': polycodeDark.name,
  'catppuccin-mocha': FLAVOUR_NAMES.mocha,
  'catppuccin-macchiato': FLAVOUR_NAMES.macchiato,
  'catppuccin-frappe': FLAVOUR_NAMES.frappe,
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

export function isCatppuccinAccent(value: unknown): value is CatppuccinAccent {
  return typeof value === 'string' && (CATPPUCCIN_ACCENTS as readonly string[]).includes(value)
}

/** True for themes that take a `CatppuccinAccent`. */
export function themeHasAccent(id: ThemeId): boolean {
  return id.startsWith('catppuccin-')
}

/** Resolve a stored theme id (and accent, for Catppuccin) to a theme. Unknown ids fall back to the default. */
export function resolveTheme(id: unknown, accent?: unknown): Theme {
  const themeId = isThemeId(id) ? id : DEFAULT_THEME_ID
  const catAccent = isCatppuccinAccent(accent) ? accent : DEFAULT_CATPPUCCIN_ACCENT
  switch (themeId) {
    case 'catppuccin-mocha': return catppuccin('mocha', catAccent)
    case 'catppuccin-macchiato': return catppuccin('macchiato', catAccent)
    case 'catppuccin-frappe': return catppuccin('frappe', catAccent)
    case 'polycode-dark': return polycodeDark
  }
}

/** A swatch for the accent picker. */
export function catppuccinAccentColor(id: ThemeId, accent: CatppuccinAccent): string {
  const flavour = id.replace('catppuccin-', '') as CatppuccinFlavour
  return (CATPPUCCIN_FLAVOURS[flavour] ?? CATPPUCCIN_FLAVOURS.mocha)[accent]
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
