import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NewProjectSheet } from '@/components/ProjectAdmin'
import { ProjectTree } from '@/components/ProjectTree'
import { TopBar } from '@/components/TopBar'
import { colors } from '@/theme/colors'

/** The Projects tab: the project → location → thread tree, as the desktop sidebar's Tree mode. */
export default function ProjectsScreen() {
  const insets = useSafeAreaInsets()
  const [showNewProject, setShowNewProject] = useState(false)
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TopBar
        right={
          <Pressable onPress={() => setShowNewProject(true)} hitSlop={8} accessibilityLabel="New project">
            <Text style={styles.plus}>＋</Text>
          </Pressable>
        }
      />
      <ProjectTree />
      <NewProjectSheet visible={showNewProject} onClose={() => setShowNewProject(false)} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  plus: { color: colors.accent, fontSize: 18, fontWeight: '500' },
})
