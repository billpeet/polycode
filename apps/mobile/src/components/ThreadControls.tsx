import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  getModelsForProvider,
  PROVIDERS,
  type ModelOption,
  type PermissionMode,
  type Provider,
  type Thread,
} from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'
import { Chip } from './ui'

type ModelsChannel =
  | 'models:claudeAvailable'
  | 'models:codexAvailable'
  | 'models:opencodeAvailable'
  | 'models:piAvailable'
  | 'models:cursorAvailable'

const MODEL_CHANNEL_BY_PROVIDER: Record<Provider, ModelsChannel> = {
  'claude-code': 'models:claudeAvailable',
  codex: 'models:codexAvailable',
  opencode: 'models:opencodeAvailable',
  pi: 'models:piAvailable',
  cursor: 'models:cursorAvailable',
}

function isProvider(value: string): value is Provider {
  return PROVIDERS.some((p) => p.id === value)
}

/** Bottom-sheet style picker for provider + model. */
export function ModelPickerSheet(props: {
  thread: Thread
  visible: boolean
  onClose: () => void
  onSelect: (provider: string, model: string) => void
}) {
  const { thread, visible, onClose, onSelect } = props
  const [provider, setProvider] = useState<Provider>(isProvider(thread.provider) ? thread.provider : 'claude-code')
  const [models, setModels] = useState<ModelOption[]>([])

  useEffect(() => {
    if (visible) setProvider(isProvider(thread.provider) ? thread.provider : 'claude-code')
  }, [visible, thread.provider])

  useEffect(() => {
    if (!visible) return
    // Static fallback immediately; live host-side availability when it answers.
    setModels([...getModelsForProvider(provider)])
    const connection = useHostsStore.getState().activeConnection()
    if (!connection) return
    let cancelled = false
    rpc(connection, MODEL_CHANNEL_BY_PROVIDER[provider], thread.id)
      .then((available) => {
        if (!cancelled && Array.isArray(available) && available.length > 0) setModels(available)
      })
      .catch(() => {
        // Keep the static fallback.
      })
    return () => {
      cancelled = true
    }
  }, [visible, provider, thread.id])

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>Provider & Model</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PROVIDERS.map((p) => (
              <Chip key={p.id} label={p.label} active={provider === p.id} onPress={() => setProvider(p.id)} />
            ))}
          </View>
          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
            {models.map((model) => {
              const selected = thread.provider === provider && thread.model === model.id
              return (
                <Pressable
                  key={model.id}
                  onPress={() => {
                    onSelect(provider, model.id)
                    onClose()
                  }}
                  style={({ pressed }) => [styles.modelRow, selected && { borderColor: colors.claude }, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.modelLabel, selected && { color: colors.claude }]}>{model.label}</Text>
                  <Text style={styles.modelId} numberOfLines={1}>
                    {model.id}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const PERMISSION_MODES: { id: PermissionMode; label: string; description: string }[] = [
  { id: 'ask', label: 'Ask', description: 'Ask before running tools that modify things' },
  { id: 'workspace', label: 'Workspace', description: 'Allow edits inside the workspace without asking' },
  { id: 'yolo', label: 'YOLO', description: 'Run everything without asking' },
]

export function PermissionModeSheet(props: {
  current: PermissionMode
  visible: boolean
  onClose: () => void
  onSelect: (mode: PermissionMode) => void
}) {
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <Pressable style={styles.backdrop} onPress={props.onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>Permission Mode</Text>
          {PERMISSION_MODES.map((mode) => (
            <Pressable
              key={mode.id}
              onPress={() => {
                props.onSelect(mode.id)
                props.onClose()
              }}
              style={({ pressed }) => [
                styles.modelRow,
                props.current === mode.id && { borderColor: colors.claude },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={[styles.modelLabel, props.current === mode.id && { color: colors.claude }]}>{mode.label}</Text>
              <Text style={styles.modelId}>{mode.description}</Text>
            </Pressable>
          ))}
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
    padding: 18,
    gap: 14,
    paddingBottom: 28,
  },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  modelRow: {
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 11,
    gap: 2,
  },
  modelLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  modelId: { color: colors.textMuted, fontSize: 12 },
})
