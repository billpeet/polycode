import { memo } from 'react'
import MarkdownDisplay from 'react-native-markdown-display'
import { colors } from '@/theme/colors'

const markdownStyles = {
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  heading1: { color: colors.text, fontSize: 22, fontWeight: '700' as const, marginTop: 8, marginBottom: 4 },
  heading2: { color: colors.text, fontSize: 19, fontWeight: '700' as const, marginTop: 8, marginBottom: 4 },
  heading3: { color: colors.text, fontSize: 17, fontWeight: '600' as const, marginTop: 6, marginBottom: 3 },
  heading4: { color: colors.text, fontSize: 15, fontWeight: '600' as const },
  heading5: { color: colors.text, fontSize: 14, fontWeight: '600' as const },
  heading6: { color: colors.text, fontSize: 13, fontWeight: '600' as const },
  strong: { fontWeight: '700' as const },
  em: { fontStyle: 'italic' as const },
  link: { color: colors.info },
  blockquote: {
    backgroundColor: colors.surface,
    borderLeftColor: colors.claude,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginVertical: 4,
  },
  code_inline: {
    backgroundColor: colors.codeBg,
    color: '#e6edf3',
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  code_block: {
    backgroundColor: colors.codeBg,
    color: '#e6edf3',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    fontFamily: 'monospace',
    fontSize: 12.5,
  },
  fence: {
    backgroundColor: colors.codeBg,
    color: '#e6edf3',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    fontFamily: 'monospace',
    fontSize: 12.5,
  },
  bullet_list: { marginVertical: 2 },
  ordered_list: { marginVertical: 2 },
  list_item: { marginVertical: 1 },
  bullet_list_icon: { color: colors.textMuted },
  ordered_list_icon: { color: colors.textMuted },
  hr: { backgroundColor: colors.border, height: 1, marginVertical: 8 },
  table: { borderColor: colors.border, borderWidth: 1, borderRadius: 6 },
  th: { padding: 6, color: colors.text },
  td: { padding: 6, color: colors.text, borderColor: colors.border },
  tr: { borderColor: colors.border },
}

export const Markdown = memo(function Markdown(props: { children: string }) {
  return <MarkdownDisplay style={markdownStyles}>{props.children}</MarkdownDisplay>
})
