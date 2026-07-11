/**
 * Minimal line-based diff for EditDiffView. The desktop app uses
 * @pierre/diffs (DOM-only); on mobile we compute a simple LCS line diff —
 * Edit tool old/new strings are small snippets, so O(n·m) is fine. Falls
 * back to "all removed + all added" when inputs are too large.
 */

export interface DiffRow {
  type: 'context' | 'add' | 'del'
  text: string
}

const MAX_LCS_CELLS = 250_000

export function diffLines(oldText: string, newText: string): DiffRow[] {
  const oldLines = oldText.length > 0 ? oldText.split('\n') : []
  const newLines = newText.length > 0 ? newText.split('\n') : []

  if (oldLines.length === 0) return newLines.map((text) => ({ type: 'add' as const, text }))
  if (newLines.length === 0) return oldLines.map((text) => ({ type: 'del' as const, text }))

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((text) => ({ type: 'del' as const, text })),
      ...newLines.map((text) => ({ type: 'add' as const, text })),
    ]
  }

  // LCS dynamic programming table.
  const n = oldLines.length
  const m = newLines.length
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1))
  const idx = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[idx(i, j)] =
        oldLines[i] === newLines[j]
          ? table[idx(i + 1, j + 1)] + 1
          : Math.max(table[idx(i + 1, j)], table[idx(i, j + 1)])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: 'context', text: oldLines[i] })
      i++
      j++
    } else if (table[idx(i + 1, j)] >= table[idx(i, j + 1)]) {
      rows.push({ type: 'del', text: oldLines[i] })
      i++
    } else {
      rows.push({ type: 'add', text: newLines[j] })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', text: oldLines[i++] })
  while (j < m) rows.push({ type: 'add', text: newLines[j++] })
  return rows
}

/** Strip ANSI escape sequences from terminal output. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;?]*[a-zA-Z]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}
