import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import * as Linking from 'expo-linking'
import { useRouter } from 'expo-router'
import type { ThreadStatus } from '@polycode/shared'
import { channelPrefixes, channelSuffix, onChannelPrefix } from '@/api/events'
import { parsePairingPayload } from '@/api/pairing'
import { sseManager } from '@/api/sse'
import { useHostsStore } from '@/stores/hosts'
import { useThreadsStore } from '@/stores/threads'
import { colors } from '@/theme/colors'

/** Coalesces bursts of thread events into a single Queue refetch. */
const QUEUE_REFRESH_DEBOUNCE_MS = 400

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

/**
 * Keeps the Queue fresh.
 *
 * Membership of the Queue changes for reasons no single event announces: a
 * thread finishing a Turn moves between sections, and — uniquely — an elapsed
 * snooze has no event behind it at all, because nothing is written when a wake
 * time arrives (ADR-0002). So besides refetching on thread activity, we refetch
 * whenever the app comes back to the foreground and whenever the SSE stream
 * reconnects, since the stream has no replay and anything missed while it was
 * down would otherwise persist as a stale Queue.
 */
function useQueueRefresh(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      // Without an active host the RPC would throw; the Queue refetches on
      // mount anyway once one is selected.
      if (!useHostsStore.getState().activeHostId) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void useThreadsStore.getState().fetchQueue()
      }, QUEUE_REFRESH_DEBOUNCE_MS)
    }

    const offStatus = onChannelPrefix(channelPrefixes.threadStatus, refresh)
    const offComplete = onChannelPrefix(channelPrefixes.threadComplete, refresh)
    const offConnect = sseManager.onConnect(refresh)
    const appStateSub = AppState.addEventListener('change', (status) => {
      if (status === 'active') refresh()
    })

    return () => {
      if (timer.current) clearTimeout(timer.current)
      offStatus()
      offComplete()
      offConnect()
      appStateSub.remove()
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
  useQueueRefresh()
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
        <Stack.Screen name="home" options={{ headerShown: false }} />
        <Stack.Screen name="queue" options={{ headerShown: false }} />
        <Stack.Screen name="hosts/index" options={{ title: 'Hosts' }} />
        <Stack.Screen name="hosts/new" options={{ title: 'Add Host' }} />
        <Stack.Screen name="hosts/scan" options={{ title: 'Scan QR Code' }} />
        <Stack.Screen name="hosts/[hostId]/edit" options={{ title: 'Edit Host' }} />
      </Stack>
    </>
  )
}
