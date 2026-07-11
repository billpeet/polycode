/**
 * Bottom-sheet action menu. Android's Alert.alert silently renders at most
 * three buttons, so any menu with more options must use this instead.
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '@/theme/colors'

export interface ActionSheetOption {
  label: string
  destructive?: boolean
  onPress: () => void
}

export function ActionSheet(props: {
  visible: boolean
  title?: string
  options: ActionSheetOption[]
  onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <Pressable style={styles.backdrop} onPress={props.onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: 14 + insets.bottom }]} onPress={() => undefined}>
          {props.title ? (
            <Text style={styles.title} numberOfLines={1}>
              {props.title}
            </Text>
          ) : null}
          {props.options.map((option, index) => (
            <Pressable
              key={index}
              onPress={() => {
                props.onClose()
                option.onPress()
              }}
              style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.optionText, option.destructive && { color: colors.danger }]}>{option.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={props.onClose} style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.7 }]}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 4,
  },
  title: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 6,
  },
  option: {
    backgroundColor: colors.surface2,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  optionText: { color: colors.text, fontSize: 15, fontWeight: '500' },
  cancel: { paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
})
