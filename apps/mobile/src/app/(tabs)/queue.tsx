import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { QueueView } from '@/components/QueueView'
import { TopBar } from '@/components/TopBar'
import { colors } from '@/theme/colors'

/**
 * The Queue tab: the cross-project list of Threads ordered by need for
 * attention. Tapping a row pushes `/thread/[threadId]`, so back returns here
 * with the filter and scroll position intact.
 */
export default function QueueScreen() {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TopBar />
      <QueueView />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
})
