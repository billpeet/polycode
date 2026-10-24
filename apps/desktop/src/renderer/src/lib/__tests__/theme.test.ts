import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATPPUCCIN_ACCENTS,
  DEFAULT_THEME_ID,
  THEME_IDS,
  resolveTheme,
  toFontStack,
} from '../../../../shared/themes'

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
    for (const id of THEME_IDS) {
      expect(Object.keys(resolveTheme(id).colors).sort(), id).toEqual(tokens)
    }
  })

  it('keeps the window background a plain hex colour, which Electron needs', () => {
    for (const id of THEME_IDS) {
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
    for (const id of THEME_IDS) {
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
