import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { Todo } from '@polycode/shared'
import { colors } from '@/theme/colors'

function todoIcon(status: Todo['status']): { icon: string; color: string } {
  switch (status) {
    case 'completed':
      return { icon: '✓', color: colors.success }
    case 'in_progress':
      return { icon: '◐', color: colors.claude }
    case 'pending':
    default:
      return { icon: '○', color: colors.textMuted }
  }
}

/** Compact header chip: "☑ 3/16" — hidden entirely when there are no tasks. */
export function TodoBadge(props: { todos: Todo[]; onPress: () => void }) {
  const { todos } = props
  if (todos.length === 0) return null
  const completed = todos.filter((t) => t.status === 'completed').length
  const anyRunning = todos.some((t) => t.status === 'in_progress')
  return (
    <Pressable onPress={props.onPress} hitSlop={8} style={({ pressed }) => [styles.badge, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.badgeIcon, anyRunning && { color: colors.claude }]}>☑</Text>
      <Text style={styles.badgeText}>
        {completed}/{todos.length}
      </Text>
    </Pressable>
  )
}

/** Bottom-sheet task list, opened from the header badge. */
export function TodoSheet(props: { todos: Todo[]; visible: boolean; onClose: () => void }) {
  const { todos, visible, onClose } = props
  const completed = todos.filter((t) => t.status === 'completed').length

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Tasks</Text>
            <Text style={styles.sheetCount}>
              {completed}/{todos.length}
            </Text>
          </View>
          <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 12 }} style={{ maxHeight: 480 }}>
            {todos.map((todo, index) => {
              const { icon, color } = todoIcon(todo.status)
              return (
                <View key={todo.id ?? index} style={styles.todoRow}>
                  <Text style={[styles.todoIcon, { color }]}>{icon}</Text>
                  <Text
                    style={[
                      styles.todoText,
                      todo.status === 'completed' && { color: colors.textMuted, textDecorationLine: 'line-through' },
                      todo.status === 'in_progress' && { color: colors.text, fontWeight: '600' },
                    ]}
                  >
                    {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                  </Text>
                </View>
              )
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: colors.surface2,
  },
  badgeIcon: { color: colors.textMuted, fontSize: 12 },
  badgeText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    paddingBottom: 28,
    gap: 12,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  sheetCount: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  todoRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  todoIcon: { fontSize: 14, width: 18, textAlign: 'center' },
  todoText: { color: colors.textMuted, fontSize: 13.5, flex: 1, lineHeight: 19 },
})
