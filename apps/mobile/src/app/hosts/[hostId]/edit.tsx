import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, ScrollView, StyleSheet, View } from 'react-native'
import { Button, Field } from '@/components/ui'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

function EditHostForm({
  hostId,
  host,
  storedToken,
}: {
  hostId: string
  host: NonNullable<ReturnType<typeof useHostsStore.getState>['hosts'][number]>
  storedToken?: string
}) {
  const router = useRouter()
  const updateHost = useHostsStore((s) => s.updateHost)
  const removeHost = useHostsStore((s) => s.removeHost)

  const [label, setLabel] = useState(host.label)
  const [baseUrl, setBaseUrl] = useState(host.baseUrl)
  const [token, setToken] = useState(storedToken ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await updateHost(hostId, { label, baseUrl, token })
      router.back()
    } catch (error) {
      Alert.alert('Could not save host', error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = () => {
    Alert.alert('Delete host?', `Remove "${host.label}" from this device?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void removeHost(hostId).then(() => router.dismissTo('/hosts'))
        },
      },
    ])
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Field label="Label" value={label} onChangeText={setLabel} />
      <Field label="Host URL" value={baseUrl} onChangeText={setBaseUrl} keyboardType="url" />
      <Field label="Token" value={token} onChangeText={setToken} secureTextEntry />
      <Button title="Save" onPress={save} loading={saving} disabled={!baseUrl || !token} />
      <Button title="Delete Host" variant="danger" onPress={confirmDelete} />
    </ScrollView>
  )
}

export default function EditHostScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const host = useHostsStore((s) => s.hosts.find((candidate) => candidate.id === hostId))
  const storedToken = useHostsStore((s) => (hostId ? s.tokens[hostId] : undefined))
  if (!host || !hostId) return <View style={styles.screen} />
  return <EditHostForm key={`${hostId}:${storedToken ?? ''}`} hostId={hostId} host={host} storedToken={storedToken} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14 },
})
