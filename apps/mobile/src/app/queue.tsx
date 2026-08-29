import { useEffect, useRef } from 'react'
import { useRouter } from 'expo-router'
import { View, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { QueueView } from '@/components/QueueView'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'

/**
 * The Queue screen: the cross-project list of Threads ordered by need for
 * attention.
 *
 * It is a route rather than a mode inside the sidebar drawer because the Queue
 * is the whole working surface when you are triaging — a 320pt drawer would
 * force project name, status and wake time to compete for the same line.
 * Selecting a thread returns to /home, where the chat lives.
 */
export default function QueueScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const selectedThreadId = useUiStore((s) => s.selectedThreadId)

  // selectThread() is shared with the sidebar, so rather than special-casing
  // navigation inside the Queue we just follow the selection back to the chat.
  // Only a *change* navigates: the selection is persisted across launches, so
  // reacting to its mere presence would bounce straight out of the Queue.
  const initialSelection = useRef(selectedThreadId)
  useEffect(() => {
    if (selectedThreadId && selectedThreadId !== initialSelection.current) router.replace('/home')
  }, [selectedThreadId, router])

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <QueueView />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
})
