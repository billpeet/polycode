import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChatView } from '@/components/ChatView'
import { Sidebar } from '@/components/Sidebar'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { colors } from '@/theme/colors'

function EmptyWorkspace(props: { onOpenSidebar: () => void }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.emptyScreen, { paddingTop: insets.top }]}>
      <View style={styles.emptyHeader}>
        <Pressable onPress={props.onOpenSidebar} hitSlop={10}>
          <Text style={styles.menuIcon}>☰</Text>
        </Pressable>
        <Text style={styles.emptyHeaderTitle}>PolyCode</Text>
      </View>
      <View style={styles.emptyBody}>
        <Text style={styles.emptyTitle}>No thread selected</Text>
        <Text style={styles.emptySubtitle}>Open the sidebar and pick a thread, or create a new one.</Text>
        <Pressable onPress={props.onOpenSidebar} style={({ pressed }) => [styles.openButton, pressed && { opacity: 0.8 }]}>
          <Text style={styles.openButtonText}>Open Sidebar</Text>
        </Pressable>
      </View>
    </View>
  )
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets()
  const selectedThreadId = useUiStore((s) => s.selectedThreadId)
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen)
  const activeHostId = useHostsStore((s) => s.activeHostId)
  const hydrated = useHostsStore((s) => s.hydrated)
  const fetchProjects = useProjectsStore((s) => s.fetch)

  // Load projects once connected so the sidebar opens instantly.
  useEffect(() => {
    if (hydrated && activeHostId) void fetchProjects()
  }, [hydrated, activeHostId, fetchProjects])

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {selectedThreadId && selectedProjectId ? (
        <View style={{ flex: 1, paddingTop: insets.top }}>
          <ChatView
            key={selectedThreadId}
            threadId={selectedThreadId}
            projectId={selectedProjectId}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        </View>
      ) : (
        <EmptyWorkspace onOpenSidebar={() => setSidebarOpen(true)} />
      )}
      <Sidebar />
    </View>
  )
}

const styles = StyleSheet.create({
  emptyScreen: { flex: 1, backgroundColor: colors.bg },
  emptyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuIcon: { color: colors.text, fontSize: 20 },
  emptyHeaderTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  emptyBody: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  emptySubtitle: { color: colors.textMuted, fontSize: 14, textAlign: 'center' },
  openButton: {
    marginTop: 8,
    backgroundColor: colors.claude,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  openButtonText: { color: '#1a1a1a', fontSize: 14, fontWeight: '600' },
})
