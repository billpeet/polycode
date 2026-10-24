import { useState } from 'react'
import {
  CATPPUCCIN_ACCENTS,
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  THEME_IDS,
  catppuccinAccentColor,
  resolveTheme,
  themeHasAccent,
  type ThemeId,
} from '../../../shared/themes'
import { useAppearance } from '../lib/theme'

const PREVIEW_TOKENS = ['bg', 'surface-2', 'text', 'accent', 'success', 'warning', 'danger', 'info'] as const

function ThemeCard({ id, selected, onSelect }: { id: ThemeId; selected: boolean; onSelect: () => void }) {
  const accent = useAppearance((s) => s.accent)
  const theme = resolveTheme(id, accent)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex flex-col gap-2 rounded-lg p-2.5 text-left transition-colors"
      style={{
        background: theme.colors.surface,
        border: `1px solid ${selected ? 'var(--color-accent)' : theme.colors.border}`,
        boxShadow: selected ? '0 0 0 1px var(--color-accent)' : undefined,
      }}
    >
      <span className="text-xs font-medium" style={{ color: theme.colors.text }}>{theme.name}</span>
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
      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
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

/** Theme, accent and fonts for this client. */
export function AppearancePanel() {
  const themeId = useAppearance((s) => s.themeId)
  const accent = useAppearance((s) => s.accent)
  const fontSans = useAppearance((s) => s.fontSans)
  const fontMono = useAppearance((s) => s.fontMono)
  const setThemeId = useAppearance((s) => s.setThemeId)
  const setAccent = useAppearance((s) => s.setAccent)
  const setFontSans = useAppearance((s) => s.setFontSans)
  const setFontMono = useAppearance((s) => s.setFontMono)

  const muted = { color: 'var(--color-text-muted)' }
  return (
    <div className="flex flex-col gap-5 text-sm" style={{ color: 'var(--color-text)' }}>
      <section className="flex flex-col gap-2">
        <div>
          <div className="font-medium">Theme</div>
          <div className="text-xs" style={muted}>Colours for the interface, terminals, code blocks and diffs.</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {THEME_IDS.map((id) => (
            <ThemeCard key={id} id={id} selected={id === themeId} onSelect={() => setThemeId(id)} />
          ))}
        </div>
      </section>

      {themeHasAccent(themeId) && (
        <section className="flex flex-col gap-2">
          <div>
            <div className="font-medium">Accent</div>
            <div className="text-xs" style={muted}>Buttons, links, focus and the pending state. <span className="capitalize">{accent}</span>.</div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CATPPUCCIN_ACCENTS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setAccent(name)}
                aria-pressed={name === accent}
                aria-label={name}
                title={name}
                className="h-6 w-6 rounded-full transition-transform hover:scale-110"
                style={{
                  background: catppuccinAccentColor(themeId, name),
                  boxShadow: name === accent
                    ? '0 0 0 2px var(--color-surface-2), 0 0 0 4px var(--color-text)'
                    : undefined,
                }}
              />
            ))}
          </div>
        </section>
      )}

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
