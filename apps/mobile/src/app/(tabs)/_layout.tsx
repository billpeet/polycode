import { Tabs, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { openNewThread } from '@/lib/navigation'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useUnifiedStore } from '@/stores/unified'
import { colors, radii } from '@/theme/colors'

/** Floating `+ New thread` above the tab bar, present on both tabs. */
function NewThreadFab() {
  const router = useRouter()
  return (
    <Pressable
      onPress={() => openNewThread(router)}
      style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel="New thread"
    >
      <Text style={styles.fabText}>＋ New thread</Text>
    </Pressable>
  )
}

/**
 * Queue-first shell: Queue | Projects tabs, mirroring the desktop sidebar's
 * Tree|Queue mode switch. Thread screens are pushed outside the tabs so the
 * keyboard never sits above a tab bar.
 */
export default function TabsLayout() {
  const insets = useSafeAreaInsets()
  const activeHostId = useHostsStore((s) => s.activeHostId)
  const hydrated = useHostsStore((s) => s.hydrated)
  const fetchProjects = useProjectsStore((s) => s.fetch)

  // Load projects once connected so the Projects tab and New-thread sheet open instantly.
  useEffect(() => {
    if (hydrated && activeHostId) void fetchProjects()
  }, [hydrated, activeHostId, fetchProjects])

  // Coming back from a thread, the New-thread sheet or the Hosts screen: whatever was
  // done there went through the active host, and the unified view only hears about the
  // parts that raise an event. Reload that host so the lists agree with it.
  const mounted = useRef(false)
  useFocusEffect(
    useCallback(() => {
      if (!mounted.current) {
        mounted.current = true
        return
      }
      const unified = useUnifiedStore.getState()
      const hostId = useHostsStore.getState().activeHostId
      if (unified.enabled && hostId) unified.scheduleRefresh(hostId)
    }, []),
  )

  const tabBarHeight = 52 + insets.bottom

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarHideOnKeyboard: true,
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            height: tabBarHeight,
            paddingBottom: insets.bottom,
          },
          tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
          sceneStyle: { backgroundColor: colors.bg },
        }}
      >
        <Tabs.Screen
          name="queue"
          options={{
            title: 'Queue',
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>▤</Text>,
          }}
        />
        <Tabs.Screen
          name="projects"
          options={{
            title: 'Projects',
            tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>▣</Text>,
          }}
        />
      </Tabs>
      <View pointerEvents="box-none" style={[styles.fabHost, { bottom: tabBarHeight + 16 }]}>
        <NewThreadFab />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fabHost: { position: 'absolute', right: 16 },
  fab: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: 18,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabText: { color: colors.onAccent, fontSize: 14, fontWeight: '700' },
})
