/**
 * Consolidated thread settings drawer: provider, model, reasoning effort and
 * permission mode in one sheet, plus favourite combos (desktop parity —
 * saved provider/model/effort presets for one-tap switching).
 */
import { useEffect, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  getModelsForProvider,
  PROVIDERS,
  type ModelOption,
  type PermissionMode,
  type Provider,
  type ReasoningLevel,
  type Thread,
} from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useFavouritesStore, favouriteEquals, formatFavourite, type Favourite } from '@/stores/favourites'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'
import { effortLabel } from './ThreadControls'
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

const ALL_REASONING_LEVELS: ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'yolo', label: 'YOLO' },
]

function isProvider(value: string): value is Provider {
  return PROVIDERS.some((p) => p.id === value)
}

export function ThreadSettingsSheet(props: {
  thread: Thread
  visible: boolean
  onClose: () => void
  onSelectModel: (provider: string, model: string) => void
  onSelectEffort: (level: ReasoningLevel) => void
  onSelectPermissionMode: (mode: PermissionMode) => void
}) {
  const { thread, visible, onClose } = props
  const insets = useSafeAreaInsets()
  const [provider, setProvider] = useState<Provider>(isProvider(thread.provider) ? thread.provider : 'claude-code')
  const [models, setModels] = useState<ModelOption[]>([])
  const favourites = useFavouritesStore((s) => s.favourites)
  const addFavourite = useFavouritesStore((s) => s.add)
  const removeFavourite = useFavouritesStore((s) => s.removeAt)

  useEffect(() => {
    if (visible) setProvider(isProvider(thread.provider) ? thread.provider : 'claude-code')
  }, [visible, thread.provider])

  useEffect(() => {
    if (!visible) return
    setModels([...getModelsForProvider(provider)])
    const connection = useHostsStore.getState().activeConnection()
    if (!connection) return
    let cancelled = false
    rpc(connection, MODEL_CHANNEL_BY_PROVIDER[provider], thread.id)
      .then((available) => {
        if (!cancelled && Array.isArray(available) && available.length > 0) setModels(available)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [visible, provider, thread.id])

  const selectedModel = models.find((m) => m.id === thread.model)
  const effortLevels: ReasoningLevel[] =
    provider === thread.provider && selectedModel?.reasoningLevels
      ? selectedModel.reasoningLevels
      : ALL_REASONING_LEVELS

  const currentCombo: Favourite = {
    provider: isProvider(thread.provider) ? thread.provider : 'claude-code',
    model: thread.model,
    reasoningLevel: thread.reasoning_level,
  }
  const isFavourited = favourites.some((f) => favouriteEquals(f, currentCombo))

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]} onPress={() => undefined}>
          <ScrollView contentContainerStyle={{ gap: 16 }} style={{ maxHeight: 620 }} nestedScrollEnabled>
            {/* Provider */}
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionTitle}>Provider</Text>
              <View style={styles.chipWrap}>
                {PROVIDERS.map((p) => (
                  <Chip key={p.id} label={p.label} active={provider === p.id} onPress={() => setProvider(p.id)} />
                ))}
              </View>
            </View>

            {/* Model */}
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionTitle}>Model</Text>
              <View style={{ gap: 6 }}>
                {models.map((model) => {
                  const selected = thread.provider === provider && thread.model === model.id
                  return (
                    <Pressable
                      key={model.id}
                      onPress={() => props.onSelectModel(provider, model.id)}
                      style={({ pressed }) => [styles.modelRow, selected && { borderColor: colors.claude }, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={[styles.modelLabel, selected && { color: colors.claude }]}>{model.label}</Text>
                      <Text style={styles.modelId} numberOfLines={1}>
                        {model.id}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>

            {/* Effort */}
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionTitle}>Reasoning Effort</Text>
              <View style={styles.chipWrap}>
                {effortLevels.map((level) => (
                  <Chip
                    key={level}
                    label={effortLabel(thread.provider, level)}
                    active={thread.reasoning_level === level}
                    onPress={() => props.onSelectEffort(level)}
                  />
                ))}
              </View>
            </View>

            {/* Permission mode */}
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionTitle}>Permission Mode</Text>
              <View style={styles.chipWrap}>
                {PERMISSION_MODES.map((mode) => (
                  <Chip
                    key={mode.id}
                    label={mode.label}
                    active={thread.permission_mode === mode.id}
                    color={mode.id === 'yolo' ? colors.danger : undefined}
                    onPress={() => props.onSelectPermissionMode(mode.id)}
                  />
                ))}
              </View>
            </View>

            {/* Favourites */}
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionTitle}>Favourites</Text>
              {favourites.map((fav, index) => (
                <View key={index} style={styles.favouriteRow}>
                  <Text style={styles.favouriteLabel} numberOfLines={1}>
                    ★ {formatFavourite(fav)}
                  </Text>
                  <Pressable
                    hitSlop={8}
                    onPress={() =>
                      Alert.alert('Remove favourite?', formatFavourite(fav), [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => removeFavourite(index) },
                      ])
                    }
                  >
                    <Text style={styles.favouriteRemove}>✕</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable
                onPress={() => (isFavourited ? undefined : addFavourite(currentCombo))}
                style={({ pressed }) => [styles.saveFavourite, (pressed || isFavourited) && { opacity: 0.6 }]}
                disabled={isFavourited}
              >
                <Text style={styles.saveFavouriteText}>
                  {isFavourited ? '★ Current combo saved' : `☆ Save current (${formatFavourite(currentCombo)})`}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
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
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  favouriteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  favouriteLabel: { color: colors.text, fontSize: 13.5, flex: 1 },
  favouriteRemove: { color: colors.textMuted, fontSize: 14 },
  saveFavourite: {
    borderWidth: 1,
    borderColor: colors.claude,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  saveFavouriteText: { color: colors.claude, fontSize: 13.5, fontWeight: '600' },
})
