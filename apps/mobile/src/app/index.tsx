import { Redirect } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

export default function Index() {
  const hydrated = useHostsStore((s) => s.hydrated)
  const activeHostId = useHostsStore((s) => s.activeHostId)

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.claude} />
      </View>
    )
  }

  return <Redirect href={activeHostId ? '/home' : '/hosts'} />
}
