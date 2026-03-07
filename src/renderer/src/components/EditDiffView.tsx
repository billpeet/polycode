import { useMemo } from 'react'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { FileContents } from '@pierre/diffs/react'

interface Props {
  /** For Edit: old_string to replace */
  oldString?: string
  /** For Edit: new_string replacement; for Write: full file content */
  newString: string
  /** File path shown in the header */
  filePath?: string
  /** Tool name — 'Edit' or 'Write' */
  toolName: 'Edit' | 'Write'
}

/** Guess a language from the file extension for Shiki highlighting. */
function langFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext || undefined
}

const EMPTY_FILE: FileContents = { name: '', contents: '' }

export default function EditDiffView({ oldString, newString, filePath, toolName }: Props) {
  const lang = langFromPath(filePath)
  const displayName = filePath ?? (toolName === 'Write' ? 'new file' : 'edit')

  const oldFile = useMemo<FileContents>(() => {
    if (toolName === 'Write') return { name: displayName, contents: '', lang }
    return { name: displayName, contents: oldString ?? '', lang }
  }, [toolName, displayName, oldString, lang])

  const newFile = useMemo<FileContents>(() => {
    return { name: displayName, contents: newString, lang }
  }, [displayName, newString, lang])

  return (
    <div className="pierre-diff-wrapper" style={{ borderRadius: 6, overflow: 'hidden' }}>
      <MultiFileDiff
        oldFile={oldFile}
        newFile={newFile}
        options={{
          theme: 'pierre-dark',
          diffStyle: 'unified',
          disableFileHeader: false,
          overflow: 'wrap',
        }}
        style={{ fontSize: '0.72rem', maxHeight: 480 }}
      />
    </div>
  )
}
