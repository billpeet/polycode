import { useMemo, useState } from 'react'
import {
  BUILTIN_THEME_IDS,
  MAX_THEME_NAME_LENGTH,
  SYNTAX_THEMES,
  TERMINAL_KEYS,
  THEME_NAMES,
  exportCustomTheme,
  isBuiltinThemeId,
  isSyntaxTheme,
  isThemeColor,
  resolveTheme,
  themeHasAccent,
  type ColorToken,
  type CustomTheme,
  type TerminalPalette,
} from '../../../shared/themes'
import { useAppearance } from '../lib/theme'
import { writeClipboardText } from '../lib/clipboard'
import { AccentPicker } from './AccentPicker'

/** Every colour token, grouped for the editor. Each token appears exactly once (see theme tests). */
export const COLOR_GROUPS: Array<{ title: string; tokens: ColorToken[] }> = [
  { title: 'Surfaces', tokens: ['bg', 'surface', 'surface-2', 'border'] },
  { title: 'Text', tokens: ['text', 'text-muted', 'text-strong'] },
  { title: 'Accent', tokens: ['accent', 'accent-strong', 'on-accent'] },
  { title: 'Code', tokens: ['inline-code', 'code-bg', 'code-header'] },
  {
    title: 'Status',
    tokens: [
      'danger', 'danger-strong', 'success', 'success-strong', 'warning', 'warning-strong',
      'info', 'info-strong', 'purple', 'purple-strong', 'orange', 'gold',
    ],
  },
]

const TOKEN_HINTS: Partial<Record<ColorToken, string>> = {
  bg: 'Window background',
  surface: 'Panels and cards',
  'surface-2': 'Inputs, dialogs, hover',
  'text-strong': 'Headings',
  'accent-strong': 'Gradient ends',
  'on-accent': 'Text on coloured buttons',
  'danger-strong': 'Destructive buttons',
  'success-strong': 'Success fills',
  'warning-strong': 'Warning fills',
  purple: 'Plan mode, thinking',
  orange: 'Stopping, fast mode',
  gold: 'Folders, git changes',
}

/**
 * `<input type="color">` only takes #rrggbb. Resolve anything else — short hex, rgb(),
 * hsl(), a base theme's color-mix() — through the browser's own colour parsing.
 */
function toPickerHex(value: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])[0-9a-f]?$/i.exec(value)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value)
  if (long) return `#${long[1]}`.toLowerCase()
  const probe = document.createElement('span')
  probe.style.color = value
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(computed)
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(computed)
  const channels = rgb
    ? rgb.slice(1, 4).map(Number)
    : srgb ? srgb.slice(1, 4).map((c) => Number(c) * 255) : null
  if (!channels) return '#000000'
  return `#${channels.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

const inputStyle = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }
const buttonStyle = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }

function ColorRow({ label, hint, value, baseValue, onChange }: {
  label: string
  hint?: string
  /** The override, or undefined when the base theme's value applies. */
  value: string | undefined
  baseValue: string
  onChange: (value: string | null) => void
}) {
  const effective = value ?? baseValue
  const [draft, setDraft] = useState(value ?? '')
  // Follow changes made elsewhere (reset, picker, base switch) without remounting,
  // which would drop an in-progress colour picker drag.
  const [shownValue, setShownValue] = useState(value)
  if (value !== shownValue) {
    setShownValue(value)
    setDraft(value ?? '')
  }
  const invalid = draft.trim() !== '' && !isThemeColor(draft)
  const commitDraft = () => {
    const next = draft.trim()
    if (next === (value ?? '')) return
    if (next === '') onChange(null)
    else if (isThemeColor(next)) onChange(next)
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${label} colour`}
        value={toPickerHex(effective)}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 flex-shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <div className="w-36 flex-shrink-0 min-w-0">
        <div className="truncate text-xs" style={{ color: value ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
          {label}{value ? ' •' : ''}
        </div>
        {hint && <div className="truncate text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{hint}</div>}
      </div>
      <input
        type="text"
        value={draft}
        placeholder={baseValue}
        spellCheck={false}
        aria-invalid={invalid}
        title={invalid ? 'Use hex (#rrggbb) or rgb()/hsl()' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => { if (e.key === 'Enter') commitDraft() }}
        className="min-w-0 flex-1 rounded px-2 py-1 font-mono text-[11px] outline-none"
        style={{ ...inputStyle, borderColor: invalid ? 'var(--color-danger)' : 'var(--color-border)' }}
      />
      <button
        type="button"
        onClick={() => onChange(null)}
        disabled={!value}
        className="w-5 flex-shrink-0 text-xs disabled:invisible"
        style={{ color: 'var(--color-text-muted)' }}
        title="Reset to the base theme's colour"
        aria-label={`Reset ${label}`}
      >
        ↺
      </button>
    </div>
  )
}

function Section({ title, children, collapsed }: { title: string; children: React.ReactNode; collapsed?: boolean }) {
  return (
    <details open={!collapsed} className="flex flex-col gap-1.5">
      <summary className="cursor-pointer select-none text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
        {title}
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>
    </details>
  )
}

/** Edits the active custom theme in place; every change applies immediately. */
export function CustomThemeEditor({ theme }: { theme: CustomTheme }) {
  const updateCustomTheme = useAppearance((s) => s.updateCustomTheme)
  const setCustomColor = useAppearance((s) => s.setCustomColor)
  const setCustomTerminalColor = useAppearance((s) => s.setCustomTerminalColor)
  const deleteCustomTheme = useAppearance((s) => s.deleteCustomTheme)
  const [name, setName] = useState(theme.name)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const base = useMemo(() => resolveTheme(theme.base, theme.accent), [theme.base, theme.accent])

  const commitName = () => {
    const next = name.trim()
    if (next && next !== theme.name) updateCustomTheme(theme.id, { name: next })
    else setName(theme.name)
  }

  const exportTheme = () => {
    void writeClipboardText(exportCustomTheme(theme)).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg p-3" style={{ border: '1px solid var(--color-border)' }}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          maxLength={MAX_THEME_NAME_LENGTH}
          aria-label="Theme name"
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === 'Enter') commitName() }}
          className="min-w-0 flex-1 rounded px-2 py-1.5 text-sm font-medium outline-none"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={exportTheme}
          className="rounded px-2.5 py-1.5 text-xs hover:opacity-90"
          style={buttonStyle}
          title="Copy this theme as JSON, to share or back up"
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <button
          type="button"
          onClick={() => (confirmDelete ? deleteCustomTheme(theme.id) : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          className="rounded px-2.5 py-1.5 text-xs hover:opacity-90"
          style={confirmDelete
            ? { background: 'var(--color-danger-strong)', color: 'var(--color-on-accent)', border: '1px solid var(--color-danger-strong)' }
            : { ...buttonStyle, color: 'var(--color-danger)' }}
        >
          {confirmDelete ? 'Really delete?' : 'Delete'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Based on</span>
          <select
            value={theme.base}
            onChange={(e) => { if (isBuiltinThemeId(e.target.value)) updateCustomTheme(theme.id, { base: e.target.value }) }}
            className="rounded px-2 py-1.5 text-xs outline-none"
            style={inputStyle}
          >
            {BUILTIN_THEME_IDS.map((id) => <option key={id} value={id}>{THEME_NAMES[id]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Syntax highlighting</span>
          <select
            value={theme.syntaxTheme ?? ''}
            onChange={(e) => updateCustomTheme(theme.id, {
              syntaxTheme: isSyntaxTheme(e.target.value) ? e.target.value : undefined,
            })}
            className="rounded px-2 py-1.5 text-xs outline-none"
            style={inputStyle}
          >
            <option value="">From base ({base.syntaxTheme})</option>
            {SYNTAX_THEMES.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
      </div>

      {themeHasAccent(theme.base) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Base accent</span>
          <AccentPicker
            themeId={theme.base}
            value={theme.accent}
            onChange={(accent) => updateCustomTheme(theme.id, { accent })}
          />
        </div>
      )}

      <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Colours left empty follow the base theme. Hex, rgb() and hsl() are accepted.
      </div>

      {COLOR_GROUPS.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.tokens.map((token) => (
            <ColorRow
              key={token}
              label={token}
              hint={TOKEN_HINTS[token]}
              value={theme.colors[token]}
              baseValue={base.colors[token]}
              onChange={(value) => setCustomColor(theme.id, token, value)}
            />
          ))}
        </Section>
      ))}

      <Section title="Terminal" collapsed>
        {TERMINAL_KEYS.map((key: keyof TerminalPalette) => (
          <ColorRow
            key={key}
            label={key}
            hint={key === 'background' && !theme.terminal.background && theme.colors.bg ? 'Follows bg' : undefined}
            value={theme.terminal[key]}
            baseValue={key === 'background' && theme.colors.bg ? theme.colors.bg : base.terminal[key]}
            onChange={(value) => setCustomTerminalColor(theme.id, key, value)}
          />
        ))}
      </Section>
    </div>
  )
}
