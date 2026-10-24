import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATPPUCCIN_ACCENTS,
  DEFAULT_THEME_ID,
  BUILTIN_THEME_IDS,
  COLOR_TOKENS,
  exportCustomTheme,
  importCustomTheme,
  isCustomThemeId,
  isOpaqueHex,
  isThemeColor,
  newCustomThemeId,
  parseCustomTheme,
  parseCustomThemes,
  resolveTheme,
  toFontStack,
  type CustomTheme,
} from '../../../../shared/themes'
import { COLOR_GROUPS } from '../../components/CustomThemeEditor'

const css = readFileSync(join(__dirname, '../../index.css'), 'utf8')

function cssDefaults(): Map<string, string> {
  const block = /@theme static \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  return new Map([...block.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

describe('themes', () => {
  it('declares every token in index.css with PolyCode Dark as the default', () => {
    const declared = cssDefaults()
    const dark = resolveTheme('polycode-dark').colors
    expect(Object.keys(dark).sort()).toEqual([...declared.keys()].sort())
    for (const [token, value] of Object.entries(dark)) {
      expect(declared.get(token), token).toBe(value)
    }
  })

  it('gives every theme every token', () => {
    const tokens = Object.keys(resolveTheme('polycode-dark').colors).sort()
    for (const id of BUILTIN_THEME_IDS) {
      expect(Object.keys(resolveTheme(id).colors).sort(), id).toEqual(tokens)
    }
  })

  it('keeps the window background a plain hex colour, which Electron needs', () => {
    for (const id of BUILTIN_THEME_IDS) {
      expect(resolveTheme(id).colors.bg, id).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('falls back to the default theme and accent for unknown values', () => {
    expect(resolveTheme('nope').id).toBe(DEFAULT_THEME_ID)
    expect(resolveTheme(null).id).toBe(DEFAULT_THEME_ID)
    expect(resolveTheme('catppuccin-mocha', 'nope').colors.accent).toBe('#cba6f7')
  })

  it('applies a Catppuccin accent and keeps purple distinct from it', () => {
    for (const accent of CATPPUCCIN_ACCENTS) {
      const colors = resolveTheme('catppuccin-mocha', accent).colors
      expect(colors.purple).not.toBe(colors.accent)
    }
    expect(resolveTheme('catppuccin-mocha', 'blue').colors.accent).toBe('#89b4fa')
  })

  it('ignores the accent for PolyCode Dark', () => {
    expect(resolveTheme('polycode-dark', 'blue').colors.accent).toBe('#e87b5f')
  })

  it('uses hex for every colour xterm parses', () => {
    for (const id of BUILTIN_THEME_IDS) {
      const { terminal, logForeground } = resolveTheme(id)
      for (const [key, value] of Object.entries({ ...terminal, logForeground })) {
        if (key === 'selectionBackground' && value.startsWith('rgba(')) continue
        expect(value, `${id}.${key}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i)
      }
    }
  })
})

describe('toFontStack', () => {
  it('returns null for an empty value', () => {
    expect(toFontStack('', 'monospace')).toBeNull()
    expect(toFontStack('  , ', 'monospace')).toBeNull()
    expect(toFontStack(undefined, 'sans-serif')).toBeNull()
  })

  it('quotes names with spaces and appends the generic family', () => {
    expect(toFontStack('JetBrainsMono Nerd Font, Menlo', 'monospace'))
      .toBe("'JetBrainsMono Nerd Font', Menlo, monospace")
    expect(toFontStack('Inter', 'sans-serif')).toBe('Inter, sans-serif')
  })

  it('keeps names the user already quoted', () => {
    expect(toFontStack('"Fira Code"', 'monospace')).toBe('"Fira Code", monospace')
  })

  it('strips characters that could escape the custom property', () => {
    const stack = toFontStack('Inter; } body { background: url(x)', 'sans-serif') ?? ''
    expect(stack).not.toMatch(/[;{}()]/)
  })
})

describe('custom themes', () => {
  const id = 'custom:abc' as const
  const custom: CustomTheme = {
    id,
    name: 'Night',
    base: 'catppuccin-mocha',
    accent: 'blue',
    colors: { bg: '#000000', accent: 'rgb(255, 0, 128)' },
    terminal: { red: '#ff0000' },
    syntaxTheme: 'dracula',
  }

  it('lays its overrides over the base theme', () => {
    const theme = resolveTheme(id, undefined, [custom])
    const base = resolveTheme('catppuccin-mocha', 'blue')
    expect(theme.id).toBe(id)
    expect(theme.name).toBe('Night')
    expect(theme.colors.bg).toBe('#000000')
    expect(theme.colors.accent).toBe('rgb(255, 0, 128)')
    expect(theme.colors.text).toBe(base.colors.text)
    expect(theme.colors['info-strong']).toBe(base.colors['info-strong'])
    expect(theme.terminal.red).toBe('#ff0000')
    expect(theme.terminal.green).toBe(base.terminal.green)
    expect(theme.syntaxTheme).toBe('dracula')
    expect(theme.diffTheme).toBe('dracula')
  })

  it('carries a changed background into the terminal unless set there', () => {
    expect(resolveTheme(id, undefined, [custom]).terminal.background).toBe('#000000')
    const pinned = { ...custom, terminal: { background: '#101010' } }
    expect(resolveTheme(id, undefined, [pinned]).terminal.background).toBe('#101010')
  })

  it('uses the base syntax palette when none is chosen', () => {
    const { syntaxTheme: _s, ...rest } = custom
    void _s
    const theme = resolveTheme(id, undefined, [rest])
    expect(theme.syntaxTheme).toBe('catppuccin-mocha')
    expect(theme.diffTheme).toBe('catppuccin-mocha')
  })

  it('falls back to the default theme when the custom theme is gone', () => {
    expect(resolveTheme(id, undefined, []).id).toBe(DEFAULT_THEME_ID)
  })

  it('accepts hex and numeric rgb()/hsl() colours only', () => {
    for (const ok of ['#fff', '#ffff', '#a1b2c3', '#a1b2c380', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgb(1 2 3 / 50%)', 'hsl(200deg 50% 40%)', 'hsla(200, 50%, 40%, 0.5)']) {
      expect(isThemeColor(ok), ok).toBe(true)
    }
    for (const bad of ['red', 'var(--x)', 'url(x)', '#ggg', '#12345', '#fff; color: red', 'rgb(1,2,3);x', 'color-mix(in srgb, red, blue)', '', null, 5]) {
      expect(isThemeColor(bad), String(bad)).toBe(false)
    }
  })

  it('drops invalid colours, unknown keys and bad entries when parsing', () => {
    const stored = JSON.stringify([
      { ...custom, colors: { bg: 'url(evil)', text: '#eee', bogus: '#fff' }, terminal: { red: 'red' }, extra: 1 },
      { id: 'custom:no-base', name: 'x', colors: {} },
      { ...custom, name: 'duplicate id' },
      'nonsense',
    ])
    const themes = parseCustomThemes(stored)
    expect(themes).toHaveLength(1)
    expect(themes[0].colors).toEqual({ text: '#eee' })
    expect(themes[0].terminal).toEqual({})
    expect(themes[0]).not.toHaveProperty('extra')
  })

  it('tolerates missing or corrupt storage', () => {
    expect(parseCustomThemes(null)).toEqual([])
    expect(parseCustomThemes('{not json')).toEqual([])
    expect(parseCustomThemes('{"a":1}')).toEqual([])
  })

  it('cleans up names', () => {
    expect(parseCustomTheme({ ...custom, name: '  a \n  b  ' })?.name).toBe('a b')
    expect(parseCustomTheme({ ...custom, name: '' })?.name).toBe('Untitled theme')
    expect(parseCustomTheme({ ...custom, name: 'x'.repeat(200) })?.name).toHaveLength(60)
  })

  it('round-trips through export and import with a new id', () => {
    const json = exportCustomTheme(custom)
    expect(JSON.parse(json)).not.toHaveProperty('id')
    const result = importCustomTheme(json, 'custom:new')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.theme).toEqual({ ...custom, id: 'custom:new' })
  })

  it('explains why an import failed', () => {
    const fail = (text: string) => {
      const result = importCustomTheme(text, 'custom:new')
      return result.ok ? null : result.error
    }
    expect(fail('nope')).toMatch(/not valid JSON/)
    expect(fail('{"name":"x","base":"polycode-dark"}')).toMatch(/not a PolyCode theme/)
    expect(fail('{"polycodeTheme":99,"base":"polycode-dark"}')).toMatch(/newer version/)
    expect(fail('{"polycodeTheme":1,"base":"solarized"}')).toMatch(/"base"/)
  })

  it('only gives Electron an opaque hex background', () => {
    expect(isOpaqueHex('#112233')).toBe(true)
    expect(isOpaqueHex('#123')).toBe(true)
    expect(isOpaqueHex('#11223344')).toBe(false)
    expect(isOpaqueHex('rgb(1, 2, 3)')).toBe(false)
  })

  it('makes well-formed ids', () => {
    expect(isCustomThemeId(newCustomThemeId())).toBe(true)
    expect(isCustomThemeId('custom:../../x')).toBe(false)
  })

  it('groups every colour token exactly once in the editor', () => {
    const grouped = COLOR_GROUPS.flatMap((g) => g.tokens)
    expect([...grouped].sort()).toEqual([...COLOR_TOKENS].sort())
  })
})
