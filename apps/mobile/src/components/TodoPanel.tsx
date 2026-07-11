import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
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

export function TodoPanel(props: { todos: Todo[] }) {
  const [expanded, setExpanded] = useState(false)
  const { todos } = props
  if (todos.length === 0) return null

  const completed = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')

  return (
    <View style={styles.container}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.header}>
        <Text style={styles.count}>
          Tasks {completed}/{todos.length}
        </Text>
        {!expanded && active ? (
          <Text style={styles.active} numberOfLines={1}>
            {active.activeForm || active.content}
          </Text>
        ) : null}
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView style={{ maxHeight: 220 }} contentContainerStyle={{ gap: 6, paddingBottom: 8, paddingHorizontal: 12 }}>
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
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  count: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
  active: { color: colors.textMuted, fontSize: 12.5, flex: 1, fontStyle: 'italic' },
  chevron: { color: colors.textMuted, fontSize: 12, marginLeft: 'auto' },
  todoRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  todoIcon: { fontSize: 13, width: 16, textAlign: 'center' },
  todoText: { color: colors.textMuted, fontSize: 13, flex: 1, lineHeight: 18 },
})
