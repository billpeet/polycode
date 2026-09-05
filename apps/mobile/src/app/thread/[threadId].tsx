import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChatView } from '@/components/ChatView'
import { useThreadsStore } from '@/stores/threads'
import { colors, radii } from '@/theme/colors'

/**
 * A thread, pushed above the tabs so the keyboard never sits over a tab bar.
 *
 * `projectId` normally arrives as a param; it is resolved from the stores
 * otherwise (deep links). A thread that is in neither — a snoozed or
 * archived one reached by link — gets a "not found" fallback: there is no
 * `threads:get` RPC to look it up by id alone.
 */
export default function ThreadScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ threadId: string; projectId?: string }>()
  const threadId = params.threadId
  const resolvedProjectId = useThreadsStore(
    (s) => s.queueThreads.find((t) => t.id === threadId)?.project_id ?? s.findThread(threadId)?.project_id,
  )
  const projectId = params.projectId || resolvedProjectId
  const fetchQueue = useThreadsStore((s) => s.fetchQueue)
  const [lookedUp, setLookedUp] = useState(false)

  useEffect(() => {
    if (projectId || lookedUp) return
    void fetchQueue().finally(() => setLookedUp(true))
  }, [projectId, lookedUp, fetchQueue])

  const goBack = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/queue')
  }

  if (!projectId) {
    return (
      <View style={[styles.fallback, { paddingTop: insets.top }]}>
        {lookedUp ? (
          <>
            <Text style={styles.fallbackTitle}>Thread not found</Text>
            <Text style={styles.fallbackText}>It may be snoozed or archived.</Text>
            <Pressable onPress={goBack} style={({ pressed }) => [styles.fallbackButton, pressed && { opacity: 0.8 }]}>
              <Text style={styles.fallbackButtonText}>Back to Queue</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <ChatView key={threadId} threadId={threadId} projectId={projectId} onBack={goBack} />
    </View>
  )
}

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32, backgroundColor: colors.bg },
  fallbackTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  fallbackText: { color: colors.textMuted, fontSize: 14, textAlign: 'center' },
  fallbackButton: {
    marginTop: 8,
    backgroundColor: colors.accent,
    borderRadius: radii.input,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  fallbackButtonText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
})
