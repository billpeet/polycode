import { ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  Table,
  Trash2,
} from 'lucide-react'

interface Props {
  editor: Editor | null
  disabled?: boolean
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  disabled?: boolean
  title: string
  children: ReactNode
}) {
  return (
    <button
      // Prevent the editor from losing focus when clicking a formatting button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-30"
      style={{
        color: active ? 'var(--color-claude)' : 'var(--color-text-muted)',
        background: active ? 'rgba(232, 123, 95, 0.12)' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--color-surface-2)'
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div className="mx-1 h-4 w-px" style={{ background: 'var(--color-border)' }} />
}

/**
 * Compact formatting toolbar for the message composer: basic marks, lists, and
 * table controls (table-specific actions appear while the cursor is in a table).
 */
export default function FormatToolbar({ editor, disabled }: Props) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) =>
      editor
        ? {
            bold: editor.isActive('bold'),
            italic: editor.isActive('italic'),
            underline: editor.isActive('underline'),
            strike: editor.isActive('strike'),
            code: editor.isActive('code'),
            bulletList: editor.isActive('bulletList'),
            orderedList: editor.isActive('orderedList'),
            inTable: editor.isActive('table'),
          }
        : null,
  })

  if (!editor || !state) return null

  const iconSize = 13

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-3 pt-2">
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={state.bold}
        disabled={disabled}
        title="Bold (Ctrl+B)"
      >
        <Bold size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={state.italic}
        disabled={disabled}
        title="Italic (Ctrl+I)"
      >
        <Italic size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={state.underline}
        disabled={disabled}
        title="Underline (Ctrl+U)"
      >
        <Underline size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={state.strike}
        disabled={disabled}
        title="Strikethrough (Ctrl+Shift+S)"
      >
        <Strikethrough size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={state.code}
        disabled={disabled}
        title="Inline code (Ctrl+E)"
      >
        <Code size={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={state.bulletList}
        disabled={disabled}
        title="Bullet list (Ctrl+Shift+8)"
      >
        <List size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={state.orderedList}
        disabled={disabled}
        title="Numbered list (Ctrl+Shift+7)"
      >
        <ListOrdered size={iconSize} />
      </ToolbarButton>

      <Divider />

      {!state.inTable ? (
        <ToolbarButton
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          disabled={disabled}
          title="Insert table"
        >
          <Table size={iconSize} />
        </ToolbarButton>
      ) : (
        <>
          <ToolbarButton
            onClick={() => editor.chain().focus().addRowAfter().run()}
            disabled={disabled}
            title="Add row below"
          >
            +Row
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            disabled={disabled}
            title="Add column right"
          >
            +Col
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().deleteRow().run()}
            disabled={disabled}
            title="Delete row"
          >
            −Row
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().deleteColumn().run()}
            disabled={disabled}
            title="Delete column"
          >
            −Col
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().deleteTable().run()}
            disabled={disabled}
            title="Delete table"
          >
            <Trash2 size={iconSize} />
          </ToolbarButton>
        </>
      )}
    </div>
  )
}
