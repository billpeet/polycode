import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { FILE_MENTION_REGEX, YOUTRACK_MENTION_REGEX } from '../FileMention'

/**
 * Matches command / skill invocations: /commit, /skill:form-filler (Pi), or
 * $skill-name (Codex). Only tokens present in the known-commands set are
 * actually highlighted.
 */
const SLASH_COMMAND_REGEX = /(?<!\S)[/$][A-Za-z0-9][\w:-]*/g

export interface ComposerHighlightOptions {
  /**
   * Returns the set of known slash command / skill invocations (including the
   * leading slash, e.g. "/commit"). Read lazily on every decoration pass so the
   * host component can swap the set without reconfiguring the extension.
   */
  getKnownCommands: () => ReadonlySet<string>
}

/** Dispatch a transaction with this meta key set to force a decoration rebuild. */
export const composerHighlightPluginKey = new PluginKey('composerHighlight')

interface HighlightRange {
  from: number
  to: number
  className: string
}

/**
 * Collect highlight ranges for a single textblock's text content.
 * `offset` is the ProseMirror position of the first character of the block.
 */
function collectRanges(text: string, offset: number, knownCommands: ReadonlySet<string>): HighlightRange[] {
  const ranges: HighlightRange[] = []

  YOUTRACK_MENTION_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = YOUTRACK_MENTION_REGEX.exec(text)) !== null) {
    ranges.push({
      from: offset + match.index,
      to: offset + match.index + match[0].length,
      className: 'composer-mention composer-mention-youtrack',
    })
  }

  FILE_MENTION_REGEX.lastIndex = 0
  while ((match = FILE_MENTION_REGEX.exec(text)) !== null) {
    const path = (match[1] ?? '') + match[2]
    const isFolder = path.endsWith('/')
    ranges.push({
      from: offset + match.index,
      to: offset + match.index + match[0].length,
      className: `composer-mention ${isFolder ? 'composer-mention-folder' : 'composer-mention-file'}`,
    })
  }

  SLASH_COMMAND_REGEX.lastIndex = 0
  while ((match = SLASH_COMMAND_REGEX.exec(text)) !== null) {
    if (!knownCommands.has(match[0])) continue
    ranges.push({
      from: offset + match.index,
      to: offset + match.index + match[0].length,
      className: 'composer-mention composer-mention-skill',
    })
  }

  return ranges
}

function buildDecorations(doc: PMNode, getKnownCommands: () => ReadonlySet<string>): DecorationSet {
  const knownCommands = getKnownCommands()
  const ranges: HighlightRange[] = []

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // Never decorate code blocks — their content is verbatim.
    if (node.type.name === 'codeBlock') return false
    // Leaf nodes (hard breaks) count as one position; map them to '\n' so the
    // regex offsets stay aligned with ProseMirror positions and the lookbehind
    // treats them as whitespace.
    const text = node.textBetween(0, node.content.size, '\n', '\n')
    ranges.push(...collectRanges(text, pos + 1, knownCommands))
    return false
  })

  // Sort by position and drop overlapping matches (first match wins).
  ranges.sort((a, b) => a.from - b.from)
  const decorations: Decoration[] = []
  let lastEnd = -1
  for (const range of ranges) {
    if (range.from < lastEnd) continue
    decorations.push(Decoration.inline(range.from, range.to, { class: range.className }))
    lastEnd = range.to
  }

  return DecorationSet.create(doc, decorations)
}

/**
 * Highlights PolyCode-specific tokens in the composer while keeping them plain
 * text: @file / @dir/ mentions, @PROJ-123 YouTrack issues, and known /skill or
 * /command invocations.
 */
export const ComposerHighlight = Extension.create<ComposerHighlightOptions>({
  name: 'composerHighlight',

  addOptions() {
    return {
      getKnownCommands: () => new Set<string>(),
    }
  },

  addProseMirrorPlugins() {
    const getKnownCommands = (): ReadonlySet<string> => this.options.getKnownCommands()

    return [
      new Plugin({
        key: composerHighlightPluginKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc, getKnownCommands),
          apply: (tr, old) => {
            if (tr.docChanged || tr.getMeta(composerHighlightPluginKey)) {
              return buildDecorations(tr.doc, getKnownCommands)
            }
            return old.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
        },
      }),
    ]
  },
})
