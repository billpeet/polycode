import { memo, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { diffLines, type DiffRow } from '@/lib/diff'
import { colors } from '@/theme/colors'

const MAX_ROWS = 300

/**
 * Unified diff block mirroring the desktop EditDiffView: file-name header,
 * red removed lines, green added lines, muted context lines.
 * Write renders the whole file as added (empty old side).
 */
export const EditDiffView = memo(function EditDiffView(props: {
  toolName: 'Edit' | 'Write'
  filePath?: string
  oldString?: string
  newString: string
}) {
  const rows = useMemo(
    () => diffLines(props.toolName === 'Write' ? '' : (props.oldString ?? ''), props.newString),
    [props.toolName, props.oldString, props.newString],
  )
  const shown = rows.slice(0, MAX_ROWS)
  const hidden = rows.length - shown.length
  const fileName = props.filePath ?? (props.toolName === 'Write' ? 'new file' : 'edit')

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText} numberOfLines={1}>
          {fileName}
        </Text>
      </View>
      <View style={styles.body}>
        {shown.map((row, index) => (
          <DiffLine key={index} row={row} />
        ))}
        {hidden > 0 ? <Text style={styles.moreText}>… {hidden} more lines</Text> : null}
      </View>
    </View>
  )
})

const DiffLine = memo(function DiffLine({ row }: { row: DiffRow }) {
  const rowStyle =
    row.type === 'add' ? styles.addRow : row.type === 'del' ? styles.delRow : undefined
  const textStyle =
    row.type === 'add' ? styles.addText : row.type === 'del' ? styles.delText : styles.contextText
  return (
    <View style={[styles.row, rowStyle]}>
      <Text style={[styles.sign, textStyle]}>{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</Text>
      <Text style={[styles.code, textStyle]}>{row.text || ' '}</Text>
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  header: {
    backgroundColor: '#161616',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: { color: colors.textMuted, fontSize: 11, fontFamily: 'monospace' },
  body: { backgroundColor: colors.codeBg, paddingVertical: 4 },
  row: { flexDirection: 'row', paddingHorizontal: 8 },
  addRow: { backgroundColor: 'rgba(74, 222, 128, 0.12)' },
  delRow: { backgroundColor: 'rgba(248, 113, 113, 0.12)' },
  sign: { width: 14, fontFamily: 'monospace', fontSize: 11 },
  code: { flex: 1, fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  addText: { color: '#4ade80' },
  delText: { color: '#f87171' },
  contextText: { color: colors.textMuted },
  moreText: { color: colors.textMuted, fontSize: 11, fontStyle: 'italic', paddingHorizontal: 10, paddingVertical: 4 },
})
