import {
  CATPPUCCIN_ACCENTS,
  DEFAULT_CATPPUCCIN_ACCENT,
  catppuccinAccentColor,
  type BuiltinThemeId,
  type CatppuccinAccent,
} from '../../../shared/themes'

/** A row of Catppuccin accent swatches for `themeId`'s flavour. */
export function AccentPicker({ themeId, value, onChange }: {
  themeId: BuiltinThemeId
  value: CatppuccinAccent | undefined
  onChange: (accent: CatppuccinAccent) => void
}) {
  const selected = value ?? DEFAULT_CATPPUCCIN_ACCENT
  return (
    <div className="flex flex-wrap gap-1.5">
      {CATPPUCCIN_ACCENTS.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onChange(name)}
          aria-pressed={name === selected}
          aria-label={name}
          title={name}
          className="h-6 w-6 rounded-full transition-transform hover:scale-110"
          style={{
            background: catppuccinAccentColor(themeId, name),
            boxShadow: name === selected
              ? '0 0 0 2px var(--color-surface-2), 0 0 0 4px var(--color-text)'
              : undefined,
          }}
        />
      ))}
    </div>
  )
}
