import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import * as Linking from 'expo-linking'
import { useRouter } from 'expo-router'
import type { ThreadStatus } from '@polycode/shared'
import { channelPrefixes, channelSuffix, onChannelPrefix } from '@/api/events'
import { parsePairingPayload } from '@/api/pairing'
import { useThreadsStore } from '@/stores/threads'
import { colors } from '@/theme/colors'

/**
 * Global SSE → store wiring that must stay alive regardless of which screen
 * is mounted: thread status dots and auto-generated titles.
 */
function useGlobalEventWiring(): void {
  useEffect(() => {
    const offStatus = onChannelPrefix(channelPrefixes.threadStatus, (channel, status) => {
      const threadId = channelSuffix(channel, channelPrefixes.threadStatus)
      useThreadsStore.getState().applyStatus(threadId, status as ThreadStatus)
    })
    const offComplete = onChannelPrefix(channelPrefixes.threadComplete, (channel, status) => {
      const threadId = channelSuffix(channel, channelPrefixes.threadComplete)
      useThreadsStore.getState().applyStatus(threadId, status as ThreadStatus)
    })
    const offTitle = onChannelPrefix(channelPrefixes.threadTitle, (channel, name) => {
      const threadId = channelSuffix(channel, channelPrefixes.threadTitle)
      if (typeof name === 'string') useThreadsStore.getState().applyTitle(threadId, name)
    })
    return () => {
      offStatus()
      offComplete()
      offTitle()
    }
  }, [])
}

/** Handle polycode://pair?url=&token=&name= deep links (QR scans from outside the app). */
function usePairingDeepLink(): void {
  const router = useRouter()
  const url = Linking.useLinkingURL()

  useEffect(() => {
    if (!url) return
    const payload = parsePairingPayload(url)
    if (!payload) return
    router.push({
      pathname: '/hosts/new',
      params: { url: payload.baseUrl, token: payload.token, name: payload.name ?? '' },
    })
  }, [url, router])
}

export default function RootLayout() {
  useGlobalEventWiring()
  usePairingDeepLink()

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="hosts/index" options={{ title: 'Hosts' }} />
        <Stack.Screen name="hosts/new" options={{ title: 'Add Host' }} />
        <Stack.Screen name="hosts/scan" options={{ title: 'Scan QR Code' }} />
        <Stack.Screen name="hosts/[hostId]/edit" options={{ title: 'Edit Host' }} />
        <Stack.Screen name="projects/index" options={{ title: 'Projects' }} />
        <Stack.Screen name="projects/[projectId]/index" options={{ title: 'Threads' }} />
        <Stack.Screen name="threads/[threadId]/index" options={{ headerShown: false }} />
      </Stack>
    </>
  )
}
