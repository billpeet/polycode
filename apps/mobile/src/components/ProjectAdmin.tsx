/**
 * Project and location management sheets: new project (clone / existing /
 * new directory) and worktree creation, over the remote-management RPC.
 */
import { useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import type { NewProjectSpec } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'
import { Button, Chip, Field } from './ui'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SourceKind = 'clone' | 'existing' | 'new'

const SOURCE_OPTIONS: { id: SourceKind; label: string; placeholder: string; field: string }[] = [
  { id: 'clone', label: 'Clone URL', placeholder: 'https://github.com/you/repo.git', field: 'Git URL' },
  { id: 'existing', label: 'Existing folder', placeholder: '~/source/my-repo', field: 'Directory' },
  { id: 'new', label: 'New folder', placeholder: '~/source/new-project', field: 'Directory' },
]

export function NewProjectSheet(props: { visible: boolean; onClose: () => void }) {
  const { visible, onClose } = props
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SourceKind>('clone')
  const [value, setValue] = useState('')
  const [creating, setCreating] = useState(false)
  const fetchProjects = useProjectsStore((s) => s.fetch)
  const source = SOURCE_OPTIONS.find((option) => option.id === kind)!

  const submit = async () => {
    const connection = useHostsStore.getState().activeConnection()
    if (!connection || !name.trim() || !value.trim()) return
    setCreating(true)
    try {
      const spec: NewProjectSpec = {
        name: name.trim(),
        allowMainBranchCommits: true,
        source:
          kind === 'clone'
            ? { kind: 'clone', gitUrl: value.trim(), parentDir: '' }
            : kind === 'existing'
              ? { kind: 'existing', path: value.trim() }
              : { kind: 'new', path: value.trim() },
      }
      const result = await rpc(connection, 'projects:createFull', spec)
      await fetchProjects()
      useUiStore.getState().expandProject(result.project.id)
      setName('')
      setValue('')
      onClose()
    } catch (error) {
      Alert.alert('Could not create project', errorText(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.title}>New Project</Text>
          <Field label="Name" placeholder="My Project" value={name} onChangeText={setName} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {SOURCE_OPTIONS.map((option) => (
              <Chip key={option.id} label={option.label} active={kind === option.id} onPress={() => setKind(option.id)} />
            ))}
          </View>
          <Field label={source.field} placeholder={source.placeholder} value={value} onChangeText={setValue} />
          {kind === 'clone' ? (
            <Text style={styles.hint}>Cloned under the host's default source directory.</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Create" onPress={submit} loading={creating} disabled={!name.trim() || !value.trim()} style={{ flex: 1 }} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

export function NewWorktreeSheet(props: {
  target: { projectId: string; parentLocationId: string } | null
  onClose: () => void
}) {
  const { target, onClose } = props
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)

  const submit = async () => {
    const connection = useHostsStore.getState().activeConnection()
    if (!connection || !target) return
    setCreating(true)
    try {
      await rpc(connection, 'locations:createWorktree', target.parentLocationId, label.trim() || null)
      await useProjectsStore.getState().fetchLocations(target.projectId)
      await useThreadsStore.getState().fetch(target.projectId)
      setLabel('')
      onClose()
    } catch (error) {
      Alert.alert('Could not create worktree', errorText(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal visible={target !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.title}>New Worktree</Text>
          <Field label="Label (optional)" placeholder="feature-x" value={label} onChangeText={setLabel} autoFocus />
          <Text style={styles.hint}>Creates a git worktree beside the main checkout, branched from main.</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Create" onPress={submit} loading={creating} style={{ flex: 1 }} />
          </View>
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
    paddingBottom: 28,
    gap: 14,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 12 },
})
