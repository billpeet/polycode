import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NewProjectSheet } from '@/components/ProjectAdmin'
import { ProjectTree } from '@/components/ProjectTree'
import { TopBar } from '@/components/TopBar'
import { UnifiedProjectTree } from '@/components/UnifiedProjectTree'
import { useUnifiedStore } from '@/stores/unified'
import { colors } from '@/theme/colors'

/**
 * The Projects tab: the project → location → thread tree, as the desktop sidebar's Tree
 * mode — for the active host, or merged across every host in the unified ("All") view.
 * A new Project is created on one host, so the `＋` is only offered for a single one.
 */
export default function ProjectsScreen() {
  const insets = useSafeAreaInsets()
  const [showNewProject, setShowNewProject] = useState(false)
  const unified = useUnifiedStore((s) => s.enabled)
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TopBar
        right={
          unified ? undefined : (
            <Pressable onPress={() => setShowNewProject(true)} hitSlop={8} accessibilityLabel="New project">
              <Text style={styles.plus}>＋</Text>
            </Pressable>
          )
        }
      />
      {unified ? <UnifiedProjectTree /> : <ProjectTree />}
      <NewProjectSheet visible={showNewProject} onClose={() => setShowNewProject(false)} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  plus: { color: colors.accent, fontSize: 18, fontWeight: '500' },
})
