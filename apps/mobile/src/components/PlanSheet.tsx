/** Plan file viewer (desktop PlanPane parity): live-updating markdown sheet. */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PlanEntry } from '@/stores/plans'
import { colors } from '@/theme/colors'
import { Markdown } from './Markdown'

export function PlanSheet(props: { plan: PlanEntry | null; visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const { plan, visible, onClose } = props

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={styles.closeIcon}>✕</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Plan</Text>
            {plan?.name ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {plan.name}
              </Text>
            ) : null}
          </View>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
          {plan?.content ? (
            <Markdown>{plan.content}</Markdown>
          ) : (
            <Text style={styles.empty}>Plan content unavailable.</Text>
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeIcon: { color: colors.text, fontSize: 18 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  empty: { color: colors.textMuted, fontSize: 13.5, textAlign: 'center', paddingVertical: 24 },
})
