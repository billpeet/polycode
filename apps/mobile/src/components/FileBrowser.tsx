/**
 * File browser rooted at the thread's repo location: directory listing via
 * files:list with breadcrumb navigation, and a monospace viewer via files:read.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { FileEntry } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

const SEP = /[\\/]/

function joinPath(base: string, name: string): string {
  const separator = base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + separator + name
}

function relativeCrumbs(root: string, current: string): string[] {
  if (current === root) return []
  return current
    .slice(root.length)
    .split(SEP)
    .filter(Boolean)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function FileBrowser(props: { rootPath: string | null; visible: boolean; onClose: () => void }) {
  const { rootPath, visible, onClose } = props
  const insets = useSafeAreaInsets()
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [viewing, setViewing] = useState<{ name: string; content: string; truncated: boolean } | null>(null)

  const load = useCallback(async (dirPath: string) => {
    const conn = useHostsStore.getState().activeConnection()
    if (!conn) return
    setLoading(true)
    try {
      const listing = await rpc(conn, 'files:list', dirPath)
      const sorted = [...listing].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      setEntries(sorted)
      setCurrentPath(dirPath)
    } catch (error) {
      Alert.alert('Could not list directory', errorText(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (visible && rootPath) {
      setViewing(null)
      void load(rootPath)
    }
  }, [visible, rootPath, load])

  const openFile = async (entry: FileEntry) => {
    const conn = useHostsStore.getState().activeConnection()
    if (!conn) return
    setLoading(true)
    try {
      const result = await rpc(conn, 'files:read', entry.path)
      if (!result) {
        Alert.alert('Cannot read file', 'The host could not read this file (binary or too large).')
        return
      }
      setViewing({ name: entry.name, content: result.content, truncated: result.truncated })
    } catch (error) {
      Alert.alert('Could not read file', errorText(error))
    } finally {
      setLoading(false)
    }
  }

  if (!visible || !rootPath) return null

  const crumbs = currentPath ? relativeCrumbs(rootPath, currentPath) : []

  const goToCrumb = (index: number) => {
    // index -1 = root
    let target = rootPath
    for (let i = 0; i <= index; i++) target = joinPath(target, crumbs[i])
    void load(target)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => (viewing ? setViewing(null) : onClose())}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => (viewing ? setViewing(null) : onClose())} hitSlop={10}>
            <Text style={styles.closeIcon}>{viewing ? '‹' : '✕'}</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {viewing ? viewing.name : 'Files'}
          </Text>
          {loading ? <ActivityIndicator size="small" color={colors.claude} /> : null}
        </View>

        {viewing ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
            <ScrollView horizontal contentContainerStyle={{ minWidth: '100%' }}>
              <Text style={styles.code} selectable>
                {viewing.content}
                {viewing.truncated ? '\n\n… (truncated by host)' : ''}
              </Text>
            </ScrollView>
          </ScrollView>
        ) : (
          <>
            {/* Breadcrumbs */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.crumbBar} contentContainerStyle={styles.crumbRow}>
              <Pressable onPress={() => void load(rootPath)} hitSlop={6}>
                <Text style={[styles.crumb, crumbs.length === 0 && styles.crumbActive]}>root</Text>
              </Pressable>
              {crumbs.map((crumb, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.crumbSep}>/</Text>
                  <Pressable onPress={() => goToCrumb(index)} hitSlop={6}>
                    <Text style={[styles.crumb, index === crumbs.length - 1 && styles.crumbActive]}>{crumb}</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>

            {/* Listing */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 6 }}>
              {entries.map((entry) => (
                <Pressable
                  key={entry.path}
                  onPress={() => (entry.isDirectory ? void load(entry.path) : void openFile(entry))}
                  style={({ pressed }) => [styles.entryRow, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.entryIcon}>{entry.isDirectory ? '📁' : '📄'}</Text>
                  <Text style={[styles.entryName, entry.isDirectory && { fontWeight: '600', color: colors.text }]} numberOfLines={1}>
                    {entry.name}
                    {entry.isSymlink ? ' →' : ''}
                  </Text>
                </Pressable>
              ))}
              {entries.length === 0 && !loading ? <Text style={styles.empty}>Empty directory</Text> : null}
            </ScrollView>
          </>
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeIcon: { color: colors.text, fontSize: 20 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', flex: 1 },
  crumbBar: {
    maxHeight: 38,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14 },
  crumb: { color: colors.textMuted, fontSize: 13 },
  crumbActive: { color: colors.claude, fontWeight: '600' },
  crumbSep: { color: colors.border, fontSize: 13 },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, paddingHorizontal: 4 },
  entryIcon: { fontSize: 14 },
  entryName: { color: colors.textMuted, fontSize: 14, flex: 1 },
  empty: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  code: { color: '#c9d1d9', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
})
