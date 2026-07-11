import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { parsePairingPayload } from '@/api/pairing'
import { Button, EmptyState } from '@/components/ui'
import { colors } from '@/theme/colors'

export default function ScanScreen() {
  const router = useRouter()
  const [permission, requestPermission] = useCameraPermissions()
  const [invalid, setInvalid] = useState(false)
  const handled = useRef(false)

  if (!permission) {
    return <View style={styles.screen} />
  }

  if (!permission.granted) {
    return (
      <View style={styles.screen}>
        <EmptyState
          title="Camera access needed"
          subtitle="PolyCode needs the camera to scan the pairing QR code shown in the desktop Remote Control panel."
        />
        <View style={{ paddingHorizontal: 24 }}>
          <Button title="Grant Camera Access" onPress={() => void requestPermission()} />
        </View>
      </View>
    )
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return
          const payload = parsePairingPayload(data)
          if (!payload) {
            setInvalid(true)
            return
          }
          handled.current = true
          router.replace({
            pathname: '/hosts/new',
            params: { url: payload.baseUrl, token: payload.token, name: payload.name ?? '' },
          })
        }}
      />
      <View style={styles.footer}>
        <Text style={styles.hint}>
          {invalid
            ? 'That QR code is not a PolyCode pairing code.'
            : 'Point the camera at the pairing QR code in Settings → Remote Control on the desktop.'}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' },
  footer: { padding: 16, backgroundColor: colors.surface },
  hint: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
})
