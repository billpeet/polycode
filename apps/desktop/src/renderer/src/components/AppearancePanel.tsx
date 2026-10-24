import { useState } from 'react'
import {
  BUILTIN_THEME_IDS,
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  MAX_CUSTOM_THEMES,
  isBuiltinThemeId,
  resolveTheme,
  themeHasAccent,
  type Theme,
} from '../../../shared/themes'
import { useActiveCustomTheme, useAppearance } from '../lib/theme'
import { AccentPicker } from './AccentPicker'
import { CustomThemeEditor } from './CustomThemeEditor'

const PREVIEW_TOKENS = ['bg', 'surface-2', 'text', 'accent', 'success', 'warning', 'danger', 'info'] as const

const muted = { color: 'var(--color-text-muted)' }
const buttonStyle = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }

function ThemeCard({ theme, selected, onSelect, badge }: {
  theme: Theme
  selected: boolean
  onSelect: () => void
  badge?: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex min-w-0 flex-col gap-2 rounded-lg p-2.5 text-left transition-colors"
      style={{
        background: theme.colors.surface,
        border: `1px solid ${selected ? 'var(--color-accent)' : theme.colors.border}`,
        boxShadow: selected ? '0 0 0 1px var(--color-accent)' : undefined,
      }}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.colors.text }}>
        <span className="truncate">{theme.name}</span>
        {badge && <span className="flex-shrink-0 text-[10px] font-normal" style={{ color: theme.colors['text-muted'] }}>{badge}</span>}
      </span>
      <span className="flex gap-1">
        {PREVIEW_TOKENS.map((token) => (
          <span
            key={token}
            className="h-3.5 w-3.5 rounded-full"
            style={{ background: theme.colors[token], border: `1px solid ${theme.colors.border}` }}
            title={token}
          />
        ))}
      </span>
    </button>
  )
}

/**
 * A font list input that saves on blur or Enter, so the whole UI does not re-lay out on
 * every keystroke. Keyed by its saved value, so it resets when that changes elsewhere.
 */
function FontInput({ label, value, placeholder, onCommit }: {
  label: string
  value: string
  placeholder: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()) }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs" style={muted}>{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        className="rounded px-2 py-1.5 text-xs outline-none"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
      />
    </label>
  )
}

/** Paste a shared theme's JSON. */
function ImportTheme({ onDone }: { onDone: () => void }) {
  const importCustomTheme = useAppearance((s) => s.importCustomTheme)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const result = importCustomTheme(text)
    if (result.ok) onDone()
    else setError(result.error)
  }
  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        placeholder={'Paste a theme copied with "Copy JSON"'}
        spellCheck={false}
        rows={6}
        autoFocus
        className="rounded px-2 py-1.5 font-mono text-[11px] outline-none"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
      />
      {error && <div role="alert" className="text-xs text-danger">{error}</div>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          className="rounded px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
        >
          Import
        </button>
        <button type="button" onClick={onDone} className="rounded px-2.5 py-1 text-xs" style={buttonStyle}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Theme, accent, custom themes and fonts for this client. */
export function AppearancePanel() {
  const themeId = useAppearance((s) => s.themeId)
  const accent = useAppearance((s) => s.accent)
  const customThemes = useAppearance((s) => s.customThemes)
  const fontSans = useAppearance((s) => s.fontSans)
  const fontMono = useAppearance((s) => s.fontMono)
  const setThemeId = useAppearance((s) => s.setThemeId)
  const setAccent = useAppearance((s) => s.setAccent)
  const setFontSans = useAppearance((s) => s.setFontSans)
  const setFontMono = useAppearance((s) => s.setFontMono)
  const createCustomTheme = useAppearance((s) => s.createCustomTheme)
  const activeCustom = useActiveCustomTheme()
  const [importing, setImporting] = useState(false)
  const atLimit = customThemes.length >= MAX_CUSTOM_THEMES

  return (
    <div className="flex flex-col gap-5 text-sm" style={{ color: 'var(--color-text)' }}>
      <section className="flex flex-col gap-2">
        <div>
          <div className="font-medium">Theme</div>
          <div className="text-xs" style={muted}>Colours for the interface, terminals, code blocks and diffs.</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {BUILTIN_THEME_IDS.map((id) => (
            <ThemeCard key={id} theme={resolveTheme(id, accent)} selected={id === themeId} onSelect={() => setThemeId(id)} />
          ))}
        </div>
      </section>

      {isBuiltinThemeId(themeId) && themeHasAccent(themeId) && (
        <section className="flex flex-col gap-2">
          <div>
            <div className="font-medium">Accent</div>
            <div className="text-xs" style={muted}>Buttons, links, focus and the pending state. <span className="capitalize">{accent}</span>.</div>
          </div>
          <AccentPicker themeId={themeId} value={accent} onChange={setAccent} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-2">
          <div>
            <div className="font-medium">Custom themes</div>
            <div className="text-xs" style={muted}>
              Start from the current theme and change any colour. Share one with Copy JSON and Import.
            </div>
          </div>
          <div className="flex flex-shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setImporting((v) => !v)}
              disabled={atLimit}
              className="rounded px-2.5 py-1 text-xs hover:opacity-90 disabled:opacity-50"
              style={buttonStyle}
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => { createCustomTheme(); setImporting(false) }}
              disabled={atLimit}
              className="rounded px-2.5 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--color-accent)', color: 'var(--color-on-accent)' }}
              title={atLimit ? `At most ${MAX_CUSTOM_THEMES} custom themes` : 'Copy the current theme into a new custom theme'}
            >
              New theme
            </button>
          </div>
        </div>
        {importing && <ImportTheme onDone={() => setImporting(false)} />}
        {customThemes.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {customThemes.map((custom) => (
              <ThemeCard
                key={custom.id}
                theme={resolveTheme(custom.id, accent, customThemes)}
                badge="custom"
                selected={custom.id === themeId}
                onSelect={() => setThemeId(custom.id)}
              />
            ))}
          </div>
        )}
        {/* Keyed so local drafts (the name) reset when another theme is opened. */}
        {activeCustom && <CustomThemeEditor key={activeCustom.id} theme={activeCustom} />}
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <div className="font-medium">Fonts</div>
          <div className="text-xs" style={muted}>
            Comma-separated font families installed on this machine. Leave empty for the default.
            The monospace font is also used by terminals and command logs.
          </div>
        </div>
        <FontInput key={fontSans} label="Interface" value={fontSans} placeholder={DEFAULT_SANS_FONT} onCommit={setFontSans} />
        <FontInput key={fontMono} label="Monospace" value={fontMono} placeholder={DEFAULT_MONO_FONT} onCommit={setFontMono} />
      </section>
    </div>
  )
}
