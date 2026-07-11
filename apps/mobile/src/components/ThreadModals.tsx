import { useEffect, useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { RepoLocation, Thread } from '@polycode/shared'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'
import { Button, Chip, Field } from './ui'

export function NewThreadModal(props: {
  projectId: string | null
  onClose: () => void
}) {
  const { projectId, onClose } = props
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)
  const create = useThreadsStore((s) => s.create)
  const selectThread = useUiStore((s) => s.selectThread)
  const [name, setName] = useState('')
  const [locations, setLocations] = useState<RepoLocation[]>([])
  const [locationId, setLocationId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!projectId) return
    setName('')
    setLocations([])
    setLocationId(null)
    void fetchLocations(projectId)
      .then((locs) => {
        setLocations(locs)
        const preferred = locs.find((l) => l.checked_out) ?? locs[0]
        setLocationId(preferred?.id ?? null)
      })
      .catch((error: unknown) => {
        Alert.alert('Could not load locations', error instanceof Error ? error.message : String(error))
      })
  }, [projectId, fetchLocations])

  const submit = async () => {
    if (!projectId || !locationId) return
    setCreating(true)
    try {
      const thread = await create(projectId, name.trim() || 'New thread', locationId)
      onClose()
      selectThread(projectId, thread.id)
    } catch (error) {
      Alert.alert('Could not create thread', error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal visible={projectId !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>New Thread</Text>
          <Field label="Name" placeholder="New thread" value={name} onChangeText={setName} autoFocus />
          {locations.length > 1 ? (
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Location</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {locations.map((location) => (
                  <Chip
                    key={location.id}
                    label={location.label || location.path}
                    active={locationId === location.id}
                    onPress={() => setLocationId(location.id)}
                  />
                ))}
              </View>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Create" onPress={submit} loading={creating} disabled={!locationId} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

export function RenameThreadModal(props: {
  target: { projectId: string; thread: Thread } | null
  onClose: () => void
}) {
  const { target, onClose } = props
  const rename = useThreadsStore((s) => s.rename)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (target) setName(target.thread.name)
  }, [target])

  const submit = async () => {
    if (!target || !name.trim()) return
    setSaving(true)
    try {
      await rename(target.projectId, target.thread.id, name.trim())
      onClose()
    } catch (error) {
      Alert.alert('Could not rename thread', error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>Rename Thread</Text>
          <Field label="Name" value={name} onChangeText={setName} autoFocus />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Rename" onPress={submit} loading={saving} disabled={!name.trim()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 18,
    gap: 14,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  label: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
})
