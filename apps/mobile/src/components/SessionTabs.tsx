import { Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native'
import type { Session } from '@polycode/shared'
import { useSessionsStore } from '@/stores/sessions'
import { colors } from '@/theme/colors'

const EMPTY_SESSIONS: Session[] = []

/**
 * Horizontal session tab strip (desktop SessionTabs parity): hidden for
 * single-session threads; tapping a tab makes that session active.
 */
export function SessionTabs(props: { threadId: string; onSwitched: () => void }) {
  const { threadId } = props
  const sessions = useSessionsStore((s) => s.sessionsByThread[threadId] ?? EMPTY_SESSIONS)
  const activeSessionId = useSessionsStore((s) => s.activeSessionByThread[threadId])
  const switchSession = useSessionsStore((s) => s.switchSession)

  if (sessions.length <= 1) return null

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.row}
    >
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId
        return (
          <Pressable
            key={session.id}
            onPress={() => {
              if (isActive) return
              switchSession(threadId, session.id)
                .then(props.onSwitched)
                .catch((error: unknown) =>
                  Alert.alert('Could not switch session', error instanceof Error ? error.message : String(error)),
                )
            }}
            style={[styles.tab, isActive && styles.tabActive]}
          >
            <Text style={[styles.tabText, isActive && styles.tabTextActive]} numberOfLines={1}>
              {session.name}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  bar: {
    maxHeight: 44,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7 },
  tab: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 11,
    paddingVertical: 6,
    maxWidth: 180,
  },
  tabActive: {
    backgroundColor: 'rgba(232, 123, 95, 0.15)',
    borderColor: 'rgba(232, 123, 95, 0.3)',
  },
  tabText: { color: colors.textMuted, fontSize: 12, fontWeight: '500' },
  tabTextActive: { color: colors.claude },
})
