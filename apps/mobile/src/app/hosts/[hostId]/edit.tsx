import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, View } from 'react-native'
import { Button, Field } from '@/components/ui'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

export default function EditHostScreen() {
  const router = useRouter()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const host = useHostsStore((s) => s.hosts.find((h) => h.id === hostId))
  const storedToken = useHostsStore((s) => (hostId ? s.tokens[hostId] : undefined))
  const updateHost = useHostsStore((s) => s.updateHost)
  const removeHost = useHostsStore((s) => s.removeHost)

  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (host) {
      setLabel(host.label)
      setBaseUrl(host.baseUrl)
    }
  }, [host])

  useEffect(() => {
    if (storedToken) setToken(storedToken)
  }, [storedToken])

  if (!host || !hostId) return <View style={styles.screen} />

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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14 },
})
