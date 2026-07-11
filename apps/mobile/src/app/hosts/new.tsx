import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RemoteConnectionStatus } from '@polycode/shared'
import { testConnection, normalizeBaseUrl } from '@/api/client'
import { Button, Field } from '@/components/ui'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

export default function NewHostScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ url?: string; token?: string; name?: string }>()
  const addHost = useHostsStore((s) => s.addHost)

  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<RemoteConnectionStatus | null>(null)

  // Prefill from QR scan / deep link params.
  useEffect(() => {
    if (params.url) setBaseUrl(params.url)
    if (params.token) setToken(params.token)
    if (params.name) setLabel(params.name)
  }, [params.url, params.token, params.name])

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection({ baseUrl: normalizeBaseUrl(baseUrl), token: token.trim() })
      setTestResult(result)
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await addHost({ label: label || baseUrl, baseUrl, token })
      router.dismissTo('/hosts')
    } catch (error) {
      Alert.alert('Could not save host', error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Field label="Label" placeholder="Work PC" value={label} onChangeText={setLabel} />
      <Field
        label="Host URL"
        placeholder="192.168.1.20:3285"
        value={baseUrl}
        onChangeText={setBaseUrl}
        keyboardType="url"
      />
      <Field
        label="Token"
        placeholder="48-character token from the Remote Control panel"
        value={token}
        onChangeText={setToken}
        secureTextEntry
      />

      {testResult ? (
        <Text style={{ color: testResult.ok ? colors.success : colors.danger, fontSize: 13 }}>
          {testResult.ok ? 'Connection OK' : `Connection failed: ${testResult.error}`}
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          title="Test Connection"
          variant="secondary"
          onPress={runTest}
          loading={testing}
          disabled={!baseUrl || !token}
          style={{ flex: 1 }}
        />
        <Button title="Save" onPress={save} loading={saving} disabled={!baseUrl || !token} style={{ flex: 1 }} />
      </View>

      <Button title="Scan QR Code Instead" variant="ghost" onPress={() => router.replace('/hosts/scan')} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14 },
})
