import { useEffect, useRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension, InputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TableKit } from '@tiptap/extension-table'
import HardBreak from '@tiptap/extension-hard-break'
import { Markdown } from 'tiptap-markdown'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { ComposerHighlight } from './composerHighlight'

/**
 * tiptap-markdown serializes hard breaks as "\<newline>" (markdown hard-break
 * syntax), which would sprinkle literal backslashes through every multi-line
 * message sent to the provider CLI. Override it to emit a plain newline —
 * with `breaks: true` markdown-it parses plain newlines back into hard breaks,
 * so the round-trip stays stable. Inside tables (where a raw newline would
 * break the row) fall back to an inline <br>.
 */
const ComposerHardBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(content: string): void; inTable?: boolean },
          node: PMNode,
          parent: PMNode,
          index: number
        ) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write(state.inTable ? '<br>' : '\n')
              return
            }
          }
        },
        parse: {
          // handled by markdown-it
        },
      },
    }
  },
})

/** Read the current document as a markdown string via the tiptap-markdown storage. */
function getMarkdown(editor: Editor): string {
  return (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? ''
}

/** Matches YouTrack issue ID patterns like JS-, JS-123, MYPROJ-42 (all uppercase project code) */
const YOUTRACK_QUERY_REGEX = /^[A-Z][A-Z0-9]*(-[0-9]*)?$/

/**
 * An active '@' or '/' trigger in the composer.
 * `from`/`to` are ProseMirror document positions spanning the trigger character
 * through the cursor — replace that range when the user picks a suggestion.
 */
export interface ComposerTrigger {
  kind: 'file' | 'youtrack' | 'slash'
  query: string
  from: number
  to: number
}

interface Props {
  /** Current value as a markdown string (the persisted draft). */
  value: string
  /** Called with the new markdown string whenever the user edits. */
  onChange: (markdown: string) => void
  /** Called when the user presses Enter to send. */
  onSend: () => void
  /** Called whenever the active '@'/'/' trigger changes (null = no trigger). */
  onTriggerChange: (trigger: ComposerTrigger | null) => void
  /** Called when the user pastes one or more images. */
  onPasteImages: (files: File[]) => void
  onFocusChange?: (focused: boolean) => void
  /** Receives the editor instance once created (and null on destroy). */
  onEditorReady?: (editor: Editor | null) => void
  /** Known slash command / skill invocations for highlighting (e.g. "/commit"). */
  getKnownCommands: () => ReadonlySet<string>
  placeholder: string
  disabled?: boolean
}

/**
 * Built-in list input rules only fire at the start of a text block, but in the
 * composer Shift+Enter inserts a hard break *within* the paragraph — so typing
 * "- " on a soft new line would never start a list. These rules match the list
 * marker right after a hard break (￼ in input-rule text), remove the break
 * and marker, split the paragraph, and wrap the new block in a list.
 */
const ListAfterBreak = Extension.create({
  name: 'listAfterBreak',
  addInputRules() {
    const makeRule = (
      find: RegExp,
      // Number of marker characters actually in the doc (typed space excluded)
      markerLen: (match: RegExpMatchArray) => number,
      toggle: 'toggleBulletList' | 'toggleOrderedList'
    ): InputRule =>
      new InputRule({
        find,
        handler: ({ chain, match, range, state }) => {
          // Compute the range from the cursor side (the typed space is not in
          // the doc yet): hard break (1 pos) + the marker characters.
          const breakPos = range.to - markerLen(match) - 1
          if (breakPos < 0 || state.doc.resolve(breakPos).nodeAfter?.type.name !== 'hardBreak') {
            return null // the '\n' wasn't a hard break — leave the text alone
          }
          chain().deleteRange({ from: breakPos, to: range.to }).splitBlock()[toggle]().run()
        },
      })
    return [
      // HardBreak.renderText() is '\n', which is how it appears in input-rule text
      makeRule(/\n([-+*])\s$/, (m) => m[1].length, 'toggleBulletList'),
      makeRule(/\n(\d+)\.\s$/, (m) => m[1].length + 1, 'toggleOrderedList'),
    ]
  },
})

/** Detect an active '@' or '/' trigger in the text block containing the cursor. */
function computeTrigger(editor: Editor): ComposerTrigger | null {
  const { selection } = editor.state
  if (!selection.empty) return null

  const { $from } = selection
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.name === 'codeBlock') return null

  // Map hard breaks to '\n' (1 char = 1 position, keeps offsets aligned).
  const textBefore = parent.textBetween(0, $from.parentOffset, '\n', '\n')
  const blockStart = $from.start()

  // ── Command detection: '/' (Claude/Pi) or '$' (Codex skills) ────────────
  const lastSlashIndex = Math.max(textBefore.lastIndexOf('/'), textBefore.lastIndexOf('$'))
  if (lastSlashIndex !== -1) {
    const charBefore = lastSlashIndex > 0 ? textBefore[lastSlashIndex - 1] : ' '
    const query = textBefore.slice(lastSlashIndex + 1)
    if ((lastSlashIndex === 0 || /\s/.test(charBefore)) && !/\s/.test(query)) {
      return { kind: 'slash', query, from: blockStart + lastSlashIndex, to: $from.pos }
    }
  }

  // ── @ mention detection ──────────────────────────────────────────────────
  const lastAtIndex = textBefore.lastIndexOf('@')
  if (lastAtIndex === -1) return null

  // '@' must be at the start of the block or preceded by whitespace
  const charBefore = lastAtIndex > 0 ? textBefore[lastAtIndex - 1] : ' '
  if (lastAtIndex > 0 && !/\s/.test(charBefore)) return null

  const query = textBefore.slice(lastAtIndex + 1)
  // Whitespace in the query means the user moved past the mention
  if (/\s/.test(query)) return null

  // YouTrack IDs are all-uppercase project codes (e.g. JS-, JS-123)
  const kind: 'youtrack' | 'file' =
    query.length >= 1 && YOUTRACK_QUERY_REGEX.test(query) ? 'youtrack' : 'file'

  return { kind, query, from: blockStart + lastAtIndex, to: $from.pos }
}

/**
 * True when the selection is inside a node where Enter should keep its default
 * editing behavior instead of sending: newline in code blocks, cell navigation in
 * tables, and continuing the list in list items (Enter on an empty item exits the
 * list, after which Enter sends).
 */
function isInEnterCapturingNode(view: EditorView): boolean {
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name
    if (name === 'codeBlock' || name === 'table' || name === 'listItem') return true
  }
  return false
}

/**
 * The rich-text message composer. TipTap-based, markdown-controlled: `value` is
 * markdown and `onChange` emits markdown, so drafts persist as plain strings and
 * the serialized message is what gets sent to the provider CLI.
 */
export default function ComposerEditor({
  value,
  onChange,
  onSend,
  onTriggerChange,
  onPasteImages,
  onFocusChange,
  onEditorReady,
  getKnownCommands,
  placeholder,
  disabled,
}: Props) {
  // Keep all callbacks in refs so the editor (created once) always sees the
  // latest closures without being recreated.
  const callbacksRef = useRef({ onChange, onSend, onTriggerChange, onPasteImages, onFocusChange, getKnownCommands })
  callbacksRef.current = { onChange, onSend, onTriggerChange, onPasteImages, onFocusChange, getKnownCommands }
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const editorRef = useRef<Editor | null>(null)
  const lastTriggerRef = useRef<string>('null')

  function emitTrigger(editor: Editor): void {
    const trigger = editor.isFocused || lastTriggerRef.current !== 'null' ? computeTrigger(editor) : null
    const key = trigger ? `${trigger.kind}:${trigger.from}:${trigger.query}` : 'null'
    if (key === lastTriggerRef.current) return
    lastTriggerRef.current = key
    callbacksRef.current.onTriggerChange(trigger)
  }

  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false },
        hardBreak: false,
      }),
      ComposerHardBreak,
      ListAfterBreak,
      TableKit.configure({
        table: { resizable: false },
      }),
      Placeholder.configure({
        placeholder: () => placeholderRef.current,
      }),
      Markdown.configure({
        // html mode so marks without markdown syntax (underline) serialize as
        // inline HTML (<u>…</u>) instead of being dropped.
        html: true,
        linkify: true,
        breaks: true,
        transformPastedText: true,
      }),
      ComposerHighlight.configure({
        getKnownCommands: () => callbacksRef.current.getKnownCommands(),
      }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      callbacksRef.current.onChange(getMarkdown(editor))
      emitTrigger(editor)
    },
    onSelectionUpdate: ({ editor }) => {
      emitTrigger(editor)
    },
    onFocus: () => callbacksRef.current.onFocusChange?.(true),
    onBlur: () => callbacksRef.current.onFocusChange?.(false),
    editorProps: {
      handleKeyDown: (view, event) => {
        // Ctrl+J inserts a newline (Unix terminal convention)
        if (event.key === 'j' && event.ctrlKey && !event.altKey && !event.metaKey) {
          editorRef.current?.chain().focus().setHardBreak().run()
          return true
        }

        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          // Inside code blocks and tables, Enter keeps its editing behavior
          if (isInEnterCapturingNode(view)) return false

          // Backslash+Enter inserts a newline (CLI convention)
          const { $from, empty } = view.state.selection
          if (empty && $from.parent.isTextblock) {
            const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n')
            if (textBefore.endsWith('\\')) {
              editorRef.current
                ?.chain()
                .focus()
                .deleteRange({ from: $from.pos - 1, to: $from.pos })
                .setHardBreak()
                .run()
              return true
            }
          }

          callbacksRef.current.onSend()
          return true
        }

        return false
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items
        if (!items) return false
        const files: File[] = []
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        }
        if (files.length === 0) return false
        callbacksRef.current.onPasteImages(files)
        return true
      },
    },
  })

  useEffect(() => {
    editorRef.current = editor
    if (editor) onEditorReady?.(editor)
    return () => {
      onEditorReady?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // Push external value changes (thread switch, send-clears-draft) into the editor.
  // Skip when the incoming value already matches to avoid caret jumps while typing.
  useEffect(() => {
    if (!editor) return
    const current = getMarkdown(editor)
    if (value !== current) {
      editor.commands.setContent(value, { emitUpdate: false })
      emitTrigger(editor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value])

  useEffect(() => {
    if (editor) editor.setEditable(!disabled)
  }, [editor, disabled])

  // Re-render decorations (placeholder text) when the placeholder prop changes.
  useEffect(() => {
    if (editor && editor.isEmpty) {
      editor.view.dispatch(editor.state.tr)
    }
  }, [editor, placeholder])

  return <EditorContent editor={editor} className="composer-editor flex-1" />
}
