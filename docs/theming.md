# Themes

PolyCode's look is set in **Settings → Appearance**: a built-in theme (PolyCode
Dark or a Catppuccin flavour, with its accent), interface and monospace fonts, and
any number of custom themes. The choice is per client — a browser connected to a
Remote Host keeps its own.

## Custom themes

**New theme** copies the current theme into a custom one and opens it in the editor.
Every change applies immediately. A custom theme stores only the colours you change;
anything left empty follows its *base* theme, so a theme keeps working when PolyCode
adds a colour later.

**Copy JSON** puts a theme on the clipboard to share or back up; **Import** takes it
back. The format:

```json
{
  "polycodeTheme": 1,
  "name": "Gruvbox",
  "base": "polycode-dark",
  "colors": {
    "bg": "#1d2021",
    "surface": "#282828",
    "text": "#ebdbb2",
    "accent": "#d79921",
    "on-accent": "#1d2021"
  },
  "terminal": { "red": "#fb4934" },
  "syntaxTheme": "gruvbox-dark-medium"
}
```

| Field | |
|---|---|
| `polycodeTheme` | Format version. Required; currently `1`. |
| `name` | Up to 60 characters. |
| `base` | `polycode-dark`, `catppuccin-mocha`, `catppuccin-macchiato` or `catppuccin-frappe`. |
| `accent` | For a Catppuccin base: `rosewater` … `lavender`. |
| `colors` | Any of the tokens below. |
| `terminal` | xterm palette: `background`, `foreground`, `cursor`, `selectionBackground`, `black` … `brightWhite`. A changed `bg` carries into the terminal unless `background` is set. |
| `syntaxTheme` | A shiki theme for code blocks and diffs (the editor lists the choices). Omit to use the base theme's. |

Colours must be hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or numeric
`rgb()`/`rgba()`/`hsl()`/`hsla()`. Anything else is dropped on import. The window
background shown before the UI loads needs an opaque hex `bg`; with any other form it
uses the base theme's.

### Colour tokens

| Token | Used for |
|---|---|
| `bg`, `surface`, `surface-2`, `border` | Window background; panels; inputs, dialogs and hover; borders |
| `text`, `text-muted`, `text-strong` | Body text; secondary text; headings |
| `accent`, `accent-strong` | Primary buttons, links, focus, pending state; gradient ends |
| `on-accent` | Text and icons on any solid coloured fill — set it dark if your accent is light |
| `inline-code`, `code-bg`, `code-header` | Inline code; code block body and header |
| `danger`, `success`, `warning`, `info` | Status text, icons and tints |
| `danger-strong`, `success-strong`, `warning-strong`, `info-strong` | Solid status fills (destructive buttons, toasts) |
| `purple`, `purple-strong` | Plan mode, thinking, renames |
| `orange`, `gold` | Stopping state, fast mode; folders and git changes |

All themes are dark: several surfaces lay translucent white over the background for
hover and selection, so a light palette will look wrong in places.

## Where it lives in the code

- `apps/desktop/src/shared/themes.ts` — built-in themes, custom theme parsing,
  validation and import/export. Shared with the main process, which reads the saved
  theme to colour the window before the renderer paints.
- `apps/desktop/src/renderer/src/index.css` — the tokens' default (PolyCode Dark)
  values, registered with Tailwind so utilities like `text-danger` exist.
- `apps/desktop/src/renderer/src/lib/theme.ts` — the appearance store: applies the
  theme as custom properties on `<html>`, persists it through `prefs`, and feeds
  xterm, shiki and `@pierre/diffs`.

New UI should use the tokens (`var(--color-danger)`, `text-danger`), never literal
colours, or it will not follow the theme.
