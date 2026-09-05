import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  getDefaultModelForProvider,
  PROVIDERS,
  type PermissionMode,
  type Provider,
  type ReasoningLevel,
  type RepoLocation,
} from '@polycode/shared'
import { ActionSheet } from '@/components/ActionSheet'
import { effortLabel } from '@/components/ThreadControls'
import { Chip, Field } from '@/components/ui'
import { pickImages, type PendingImage } from '@/lib/attachments'
import { startThread, type LocationChoice } from '@/lib/create-thread'
import { locationLabel, worktreeParent } from '@/lib/locations'
import { modelLabel, useAvailableModels } from '@/lib/models'
import { openThread } from '@/lib/navigation'
import { permissionOptionsForProvider } from '@/lib/permissions'
import { favouriteChipLabel, favouriteEquals, useFavouritesStore, type Favourite } from '@/stores/favourites'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { colors, permissionAccent, radii, sectionLabel } from '@/theme/colors'

const ALL_REASONING_LEVELS: ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EMPTY_LOCATIONS: RepoLocation[] = []

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultAgent(favourites: Favourite[]): Favourite {
  return favourites[0] ?? { provider: 'claude-code', model: getDefaultModelForProvider('claude-code'), reasoningLevel: 'off' }
}

/** Provider + model picker for the `Other…` chip. */
function AgentPickerSheet(props: {
  visible: boolean
  current: Favourite
  onClose: () => void
  onSelect: (agent: Favourite) => void
}) {
  const insets = useSafeAreaInsets()
  const [provider, setProvider] = useState<Provider>(props.current.provider)
  const models = useAvailableModels(provider, null, props.visible)
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <Pressable style={styles.backdrop} onPress={props.onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: 16 + insets.bottom }]} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>Provider & Model</Text>
          <View style={styles.chipWrap}>
            {PROVIDERS.map((p) => (
              <Chip key={p.id} label={p.label} active={provider === p.id} onPress={() => setProvider(p.id)} />
            ))}
          </View>
          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
            {models.map((model) => {
              const selected = props.current.provider === provider && props.current.model === model.id
              return (
                <Pressable
                  key={model.id}
                  onPress={() => {
                    props.onSelect({ provider, model: model.id, reasoningLevel: 'off' })
                    props.onClose()
                  }}
                  style={({ pressed }) => [styles.modelRow, selected && { borderColor: colors.accent }, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.modelLabel, selected && { color: colors.accent }]}>{model.label}</Text>
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

/**
 * The New-thread sheet: project, location (or a new worktree), agent,
 * permission mode and the first message, created on "Start thread".
 *
 * Mobile deviates from the desktop's create-on-send draft here on purpose: a
 * phone has no side panel to hold a half-configured draft, so the form is the
 * draft. The result is the same row on both clients — a `'New thread'` that
 * the provider auto-titles.
 */
export default function NewThreadScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ projectId?: string }>()

  const projects = useProjectsStore((s) => s.projects)
  const fetchProjects = useProjectsStore((s) => s.fetch)
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)
  const queueThreads = useThreadsStore((s) => s.queueThreads)
  const favourites = useFavouritesStore((s) => s.favourites)

  const [chosenProjectId, setProjectId] = useState<string | null>(params.projectId ?? null)
  const [location, setLocation] = useState<LocationChoice | null>(null)
  const [agent, setAgent] = useState<Favourite>(() => defaultAgent(favourites))
  const [chosenPermissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [planMode, setPlanMode] = useState(false)
  const [message, setMessage] = useState('')
  const [attachments, setAttachments] = useState<PendingImage[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [locationsLoading, setLocationsLoading] = useState(false)

  useEffect(() => {
    if (projects.length === 0) void fetchProjects()
  }, [projects.length, fetchProjects])

  // The param wins; otherwise the first project, once the list arrives.
  const projectId = chosenProjectId ?? projects[0]?.id ?? null
  const project = projects.find((p) => p.id === projectId) ?? null
  const locations = useProjectsStore((s) => (projectId ? s.locationsByProject[projectId] : undefined) ?? EMPTY_LOCATIONS)

  // Switching project reloads its locations and resets the choice to the
  // checked-out one. Fetching is synchronisation with the host, so it lives in
  // an effect — but the state resets hop through a microtask so nothing
  // setStates synchronously in the effect body.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    Promise.resolve()
      .then(() => {
        if (cancelled) return
        setLocation(null)
        setLocationsLoading(true)
        return fetchLocations(projectId)
      })
      .then((locs) => {
        if (!locs) return
        if (cancelled) return
        const preferred = locs.find((l) => l.checked_out) ?? locs[0]
        if (preferred) setLocation({ kind: 'existing', id: preferred.id })
      })
      .catch((error: unknown) => {
        if (!cancelled) Alert.alert('Could not load locations', errorText(error))
      })
      .finally(() => {
        if (!cancelled) setLocationsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, fetchLocations])

  const runningByLocation = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of queueThreads) {
      if (t.project_id !== projectId || t.status !== 'running') continue
      if (t.location_id) counts.set(t.location_id, (counts.get(t.location_id) ?? 0) + 1)
    }
    return counts
  }, [queueThreads, projectId])
  const runningInProject = useMemo(
    () => queueThreads.filter((t) => t.project_id === projectId && t.status === 'running').length,
    [queueThreads, projectId],
  )
  const parent = worktreeParent(locations)

  const models = useAvailableModels(agent.provider, null)
  const effortLevels = models.find((m) => m.id === agent.model)?.reasoningLevels ?? ALL_REASONING_LEVELS
  const permissionOptions = permissionOptionsForProvider(agent.provider)
  const agentIsFavourite = favourites.some((f) => favouriteEquals(f, agent))
  // A provider switch keeps the chosen mode only if the new provider honours it.
  const permissionMode: PermissionMode = permissionOptions.some((o) => o.mode === chosenPermissionMode)
    ? chosenPermissionMode
    : 'ask'

  const canStart =
    !submitting &&
    projectId !== null &&
    location !== null &&
    (message.trim().length > 0 || attachments.length > 0)

  const handleStart = useCallback(() => {
    if (!projectId || !location || submitting) return
    setSubmitting(true)
    void (async () => {
      try {
        const result = await startThread({
          projectId,
          location,
          agent,
          permissionMode,
          planMode,
          message,
          attachments,
        })
        if (result.sendError) Alert.alert('Thread created, but the message failed to send', errorText(result.sendError))
        // Dismiss the modal first so back from the thread lands on the tab, not here.
        router.dismiss()
        openThread(router, { id: result.thread.id, project_id: projectId })
      } catch (error) {
        setSubmitting(false)
        Alert.alert('Could not start thread', errorText(error))
      }
    })()
  }, [projectId, location, submitting, agent, permissionMode, planMode, message, attachments, router])

  const addImages = () =>
    void pickImages()
      .then((picked) => setAttachments((prev) => [...prev, ...picked]))
      .catch((error: unknown) => Alert.alert('Could not pick image', errorText(error)))

  const worktreeLabel = location?.kind === 'new-worktree' ? location.label : ''

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: Platform.OS === 'ios' ? 12 : insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>New thread</Text>
        <View style={{ width: 52 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* 1. Project */}
        <Text style={sectionLabel}>Project</Text>
        <Pressable
          onPress={() => setShowProjectPicker(true)}
          style={({ pressed }) => [styles.pickerRow, pressed && { opacity: 0.7 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.pickerTitle}>{project?.name ?? 'Choose a project'}</Text>
            {project ? (
              <Text style={styles.pickerMeta}>
                {runningInProject} running · {locations.length} {locations.length === 1 ? 'location' : 'locations'}
              </Text>
            ) : null}
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        {/* 2. Location */}
        <Text style={sectionLabel}>Location</Text>
        {locationsLoading && locations.length === 0 ? <ActivityIndicator color={colors.textMuted} /> : null}
        {locations.map((loc) => {
          const selected = location?.kind === 'existing' && location.id === loc.id
          const running = runningByLocation.get(loc.id) ?? 0
          return (
            <Pressable
              key={loc.id}
              onPress={() => setLocation({ kind: 'existing', id: loc.id })}
              style={({ pressed }) => [styles.radioRow, selected && styles.radioRowSelected, pressed && { opacity: 0.7 }]}
            >
              <View style={[styles.radio, selected && styles.radioSelected]} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.radioTitle} numberOfLines={1}>
                  {locationLabel(loc)}
                </Text>
                <Text style={styles.radioMeta} numberOfLines={1}>
                  {[loc.checked_out ? 'checked out' : null, running > 0 ? `${running} running` : null]
                    .filter(Boolean)
                    .join(' · ') || loc.path}
                </Text>
              </View>
            </Pressable>
          )
        })}
        {parent ? (
          <Pressable
            onPress={() => setLocation({ kind: 'new-worktree', parentId: parent.id, label: worktreeLabel })}
            style={({ pressed }) => [
              styles.radioRow,
              location?.kind === 'new-worktree' && styles.radioRowSelected,
              pressed && { opacity: 0.7 },
            ]}
          >
            <View style={[styles.radio, location?.kind === 'new-worktree' && styles.radioSelected]} />
            <View style={{ flex: 1, gap: 8 }}>
              <Text style={[styles.radioTitle, { color: colors.accent }]}>＋ New worktree</Text>
              {location?.kind === 'new-worktree' ? (
                <>
                  <Field
                    placeholder="Worktree name (optional)"
                    value={worktreeLabel}
                    onChangeText={(label) => setLocation({ kind: 'new-worktree', parentId: parent.id, label })}
                  />
                  <Text style={styles.helper}>Branched from {parent.label || parent.path}, beside the main checkout</Text>
                </>
              ) : null}
            </View>
          </Pressable>
        ) : null}
        {!locationsLoading && locations.length === 0 && project ? (
          <Text style={styles.helper}>This project has no locations yet — add one on the desktop.</Text>
        ) : null}

        {/* 3. Agent */}
        <Text style={sectionLabel}>Agent</Text>
        <View style={styles.chipWrap}>
          {favourites.map((fav, index) => (
            <Chip
              key={index}
              label={`★ ${favouriteChipLabel(fav)}`}
              active={favouriteEquals(fav, agent)}
              onPress={() => setAgent(fav)}
            />
          ))}
          <Chip
            label={agentIsFavourite ? 'Other…' : `${modelLabel(agent.provider, agent.model)} ▾`}
            active={!agentIsFavourite}
            onPress={() => setShowAgentPicker(true)}
          />
        </View>
        <View style={styles.chipWrap}>
          {effortLevels.map((level) => (
            <Chip
              key={level}
              label={effortLabel(agent.provider, level)}
              active={agent.reasoningLevel === level}
              onPress={() => setAgent({ ...agent, reasoningLevel: level })}
            />
          ))}
        </View>

        {/* 4. Permission */}
        <Text style={sectionLabel}>Permissions</Text>
        <View style={styles.segmented}>
          {permissionOptions.map((option) => {
            const active = permissionMode === option.mode
            const accent = permissionAccent[option.mode]
            return (
              <Pressable
                key={option.mode}
                onPress={() => setPermissionMode(option.mode)}
                style={({ pressed }) => [
                  styles.segment,
                  active && { backgroundColor: accent.background, borderColor: accent.color },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.segmentText, active && { color: accent.color }]}>{option.label}</Text>
              </Pressable>
            )
          })}
        </View>
        <Text style={styles.helper}>{permissionOptions.find((o) => o.mode === permissionMode)?.description}</Text>

        {/* 5. Message */}
        <Text style={sectionLabel}>Message</Text>
        <TextInput
          style={styles.message}
          placeholder="What should the agent work on?"
          placeholderTextColor={colors.textMuted}
          value={message}
          onChangeText={setMessage}
          multiline
          textAlignVertical="top"
        />
        {attachments.length > 0 ? (
          <View style={styles.chipWrap}>
            {attachments.map((attachment) => (
              <Chip
                key={attachment.id}
                label={`🖼 ${attachment.name} ✕`}
                onPress={() => setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* 6. Footer */}
      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Pressable onPress={() => setPlanMode((v) => !v)} hitSlop={6}>
          <View style={[styles.planChip, planMode && styles.planChipActive]}>
            <Text style={[styles.planChipText, planMode && { color: colors.accent }]}>Plan mode</Text>
          </View>
        </Pressable>
        <Pressable onPress={addImages} hitSlop={6}>
          <View style={styles.planChip}>
            <Text style={styles.planChipText}>＋ Image</Text>
          </View>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={handleStart}
          disabled={!canStart}
          style={({ pressed }) => [styles.start, !canStart && { opacity: 0.4 }, pressed && { opacity: 0.8 }]}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Text style={styles.startText}>Start thread ›</Text>
          )}
        </Pressable>
      </View>

      <ActionSheet
        visible={showProjectPicker}
        title="Project"
        onClose={() => setShowProjectPicker(false)}
        options={projects.map((p) => ({ label: p.name, onPress: () => setProjectId(p.id) }))}
      />
      <AgentPickerSheet
        visible={showAgentPicker}
        current={agent}
        onClose={() => setShowAgentPicker(false)}
        onSelect={setAgent}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  cancel: { color: colors.accent, fontSize: 15, width: 52 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  body: { padding: 16, gap: 10, paddingBottom: 32 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.card,
    padding: 12,
    marginBottom: 8,
  },
  pickerTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  pickerMeta: { color: colors.textMuted, fontSize: 12 },
  chevron: { color: colors.textMuted, fontSize: 20 },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.card,
    padding: 12,
  },
  radioRowSelected: { borderColor: colors.accent, backgroundColor: colors.accentTint },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.textMuted, marginTop: 1 },
  radioSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  radioTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  radioMeta: { color: colors.textMuted, fontSize: 12 },
  helper: { color: colors.textMuted, fontSize: 12 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segmented: { flexDirection: 'row', gap: 8 },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  message: {
    minHeight: 110,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.input,
    padding: 12,
    color: colors.text,
    fontSize: 15,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  planChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  planChipActive: { borderColor: colors.accent, backgroundColor: colors.accentTint },
  planChipText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  start: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minWidth: 120,
    alignItems: 'center',
  },
  startText: { color: colors.onAccent, fontSize: 14, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    gap: 14,
  },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  modelRow: {
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.input,
    padding: 11,
    gap: 2,
  },
  modelLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  modelId: { color: colors.textMuted, fontSize: 12 },
})
