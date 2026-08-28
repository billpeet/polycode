import type { Terminal, ILink, IBufferRange } from '@xterm/xterm'

/**
 * Clickable URLs in xterm-backed log panes.
 *
 * Wraps xterm's link provider API with two things the plain API leaves out:
 * URLs that span xterm's *physical* rows (long log lines wrap — the provider
 * is queried per row, so we expand to the logical line before matching), and
 * trailing sentence punctuation that the URL regex greedily swallows
 * ("… https://a.localhost." is not "…localhost.").
 *
 * Only the matching and range math is exported for tests; the xterm glue is
 * `registerUrlLinks`.
 */

/** Characters that commonly trail a URL in prose but are not part of it. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '\'', '"'])

const URL_PATTERN = /https?:\/\/[^\s"'<>()]+/g

export interface UrlMatch {
  /** Inclusive start offset into the logical line text. */
  start: number
  /** Exclusive end offset into the logical line text. */
  end: number
  url: string
}

/** Trim characters that prose puts after a URL but never inside it. */
function trimTrailing(text: string): string {
  let end = text.length
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1])) end -= 1
  return text.slice(0, end)
}

export function findUrlMatches(lineText: string): UrlMatch[] {
  const matches: UrlMatch[] = []
  for (const m of lineText.matchAll(URL_PATTERN)) {
    // "http://x" is the shortest thing that could resolve to a host; anything
    // that trims down to the bare scheme is log noise, not a link.
    const url = trimTrailing(m[0])
    if (url.length > 8) {
      matches.push({ start: m.index, end: m.index + url.length, url })
    }
  }
  return matches
}

/** One physical xterm row's contribution to a logical line. */
export interface LineSegment {
  /** Absolute buffer row (0-based). */
  row: number
  /** Offset of this segment's first character in the logical line text. */
  start: number
  length: number
}

/**
 * Map offsets in the logical line to an xterm range (1-based cells; the end
 * cell is exclusive). An exclusive end that sits on a segment boundary belongs
 * to the *previous* segment — it points one cell past its last character.
 */
export function rangeForOffset(segments: LineSegment[], start: number, end: number): IBufferRange | null {
  const startSeg = segments.find((s) => start >= s.start && start < s.start + s.length)
  if (!startSeg) return null
  let endSeg: LineSegment | undefined
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].start < end) {
      endSeg = segments[i]
      break
    }
  }
  if (!endSeg) return null
  return {
    start: { x: start - startSeg.start + 1, y: startSeg.row + 1 },
    end: { x: end - endSeg.start + 1, y: endSeg.row + 1 },
  }
}

function buildLinks(term: Terminal, lineNumber: number, onActivate: (url: string) => void): ILink[] {
  const buffer = term.buffer.active
  const physical = lineNumber - 1
  if (physical < 0 || physical >= buffer.length) return []

  // Expand the queried physical row to its logical line: walk up over rows
  // that wrapped into this one, then down over rows this one wraps into.
  let first = physical
  while (first > 0 && buffer.getLine(first - 1)?.isWrapped) first -= 1
  const segments: LineSegment[] = []
  let text = ''
  let row = first
  for (;;) {
    const line = buffer.getLine(row)
    if (!line) break
    segments.push({ row, start: text.length, length: line.length })
    text += line.translateToString(true)
    row += 1
    if (!buffer.getLine(row)?.isWrapped) break
  }

  const links: ILink[] = []
  for (const match of findUrlMatches(text)) {
    const range = rangeForOffset(segments, match.start, match.end)
    if (!range) continue
    const url = match.url
    links.push({ range, text: url, activate: () => onActivate(url) })
  }
  return links
}

/**
 * Register clickable URLs on a terminal. Returns a disposer for the
 * terminal's cleanup path.
 */
export function registerUrlLinks(
  term: Terminal,
  onActivate: (url: string) => void,
): { dispose(): void } {
  const provider = term.registerLinkProvider({
    provideLinks: (lineNumber, callback) => {
      callback(buildLinks(term, lineNumber, onActivate))
    },
  })
  return { dispose: () => provider.dispose() }
}
