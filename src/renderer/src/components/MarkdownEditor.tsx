import { useEffect } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from 'tiptap-markdown'

/** Read the current document as a markdown string via the tiptap-markdown storage. */
function getMarkdown(editor: Editor): string {
  return (editor.storage as { markdown?: { getMarkdown(): string } }).markdown?.getMarkdown() ?? ''
}

interface Props {
  /** Current value as a markdown string. */
  value: string
  /** Called with the new markdown string whenever the user edits. */
  onChange: (markdown: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
}

/**
 * A TipTap-based rich text editor that reads and writes markdown.
 *
 * The component is "markdown-controlled": `value` is markdown, and `onChange` emits markdown.
 * Typing rich text (or markdown shortcuts like `**bold**`, `# heading`, `- list`) is serialized
 * back to markdown via the tiptap-markdown extension. External updates to `value` (e.g. AI
 * generation) are pushed into the editor without clobbering the caret during normal typing.
 */
export default function MarkdownEditor({ value, onChange, placeholder, disabled, className, style }: Props) {
  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        // tiptap-markdown handles serialization; keep the default nodes/marks.
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder: placeholder ?? 'Description (markdown supported)' }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: true,
        transformPastedText: true,
      }),
    ],
    content: value,
    onUpdate: ({ editor }) => {
      onChange(getMarkdown(editor))
    },
  })

  // Push external value changes (e.g. AI generation, reset) into the editor.
  // Skip when the incoming value already matches what the editor holds to avoid caret jumps.
  useEffect(() => {
    if (!editor) return
    const current = getMarkdown(editor)
    if (value !== current) {
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [editor, value])

  useEffect(() => {
    if (editor) editor.setEditable(!disabled)
  }, [editor, disabled])

  return (
    <EditorContent
      editor={editor}
      className={`markdown-editor prose-content ${className ?? ''}`}
      style={style}
    />
  )
}
