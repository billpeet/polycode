/**
 * Project commands panel: per-location start/stop/restart with live status
 * dots, detected ports, and a live-streaming log viewer (SSE command:log).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { CommandLogLine, CommandStatus, ProjectCommand, RepoLocation } from '@polycode/shared'
import { channels, onChannel } from '@/api/events'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { colors } from '@/theme/colors'
import { Button, Chip } from './ui'

function statusColor(status: CommandStatus | undefined): string {
  switch (status) {
    case 'running':
      return colors.success
    case 'stopping':
      return colors.warning
    case 'error':
      return colors.danger
    case 'stopped':
    case 'idle':
    default:
      return colors.textMuted
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MAX_LOG_LINES = 500

function LogViewer(props: { command: ProjectCommand; locationId: string; onBack: () => void }) {
  const { command, locationId } = props
  const [lines, setLines] = useState<CommandLogLine[]>([])
  const scrollRef = useRef<ScrollView>(null)

  useEffect(() => {
    const conn = useHostsStore.getState().activeConnection()
    if (conn) {
      rpc(conn, 'commands:getLogs', command.id, locationId)
        .then((logs) => setLines(logs.slice(-MAX_LOG_LINES)))
        .catch(() => undefined)
    }
    return onChannel(channels.commandLog(command.id, locationId), (_channel, batch) => {
      if (!Array.isArray(batch)) return
      setLines((prev) => [...prev, ...(batch as CommandLogLine[])].slice(-MAX_LOG_LINES))
    })
  }, [command.id, locationId])

  return (
    <>
      <View style={styles.logHeader}>
        <Pressable onPress={props.onBack} hitSlop={10}>
          <Text style={styles.backIcon}>‹</Text>
        </Pressable>
        <Text style={styles.logTitle} numberOfLines={1}>
          {command.name} — logs
        </Text>
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <Text style={styles.logText} selectable>
          {lines.map((line) => line.text).join('\n') || '(no output yet)'}
        </Text>
      </ScrollView>
    </>
  )
}

export function CommandsPanel(props: { projectId: string | null; onClose: () => void }) {
  const { projectId, onClose } = props
  const insets = useSafeAreaInsets()
  const locations = useProjectsStore((s) => (projectId ? s.locationsByProject[projectId] : undefined))
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)

  const [commands, setCommands] = useState<ProjectCommand[]>([])
  const [locationId, setLocationId] = useState<string | null>(null)
  const [statusByCommand, setStatusByCommand] = useState<Record<string, CommandStatus>>({})
  const [portsByCommand, setPortsByCommand] = useState<Record<string, number[]>>({})
  const [loading, setLoading] = useState(false)
  const [viewingLogs, setViewingLogs] = useState<ProjectCommand | null>(null)

  // Load commands + locations when opened.
  useEffect(() => {
    if (!projectId) return
    setViewingLogs(null)
    setStatusByCommand({})
    setPortsByCommand({})
    const conn = useHostsStore.getState().activeConnection()
    if (!conn) return
    setLoading(true)
    Promise.all([rpc(conn, 'commands:list', projectId), fetchLocations(projectId)])
      .then(([list, locs]) => {
        setCommands(list)
        const preferred = locs.find((l: RepoLocation) => l.checked_out) ?? locs[0]
        setLocationId(preferred?.id ?? null)
      })
      .catch((error: unknown) => Alert.alert('Could not load commands', errorText(error)))
      .finally(() => setLoading(false))
  }, [projectId, fetchLocations])

  // Fetch statuses + ports for the selected location, live-updated via SSE.
  useEffect(() => {
    if (!projectId || !locationId || commands.length === 0) return
    const conn = useHostsStore.getState().activeConnection()
    if (!conn) return

    for (const command of commands) {
      rpc(conn, 'commands:getStatus', command.id, locationId)
        .then((status) => setStatusByCommand((prev) => ({ ...prev, [command.id]: status })))
        .catch(() => undefined)
      rpc(conn, 'commands:getPorts', command.id, locationId)
        .then((ports) => setPortsByCommand((prev) => ({ ...prev, [command.id]: ports })))
        .catch(() => undefined)
    }

    const offs = commands.flatMap((command) => [
      onChannel(channels.commandStatus(command.id, locationId), (_c, status) => {
        setStatusByCommand((prev) => ({ ...prev, [command.id]: status as CommandStatus }))
      }),
      onChannel(channels.commandPorts(command.id, locationId), (_c, ports) => {
        if (Array.isArray(ports)) setPortsByCommand((prev) => ({ ...prev, [command.id]: ports as number[] }))
      }),
    ])
    return () => offs.forEach((off) => off())
  }, [projectId, locationId, commands])

  if (!projectId) return null

  const run = (label: string, commandId: string, channel: 'commands:start' | 'commands:stop' | 'commands:restart') => {
    const conn = useHostsStore.getState().activeConnection()
    if (!conn || !locationId) return
    rpc(conn, channel, commandId, locationId).catch((error: unknown) => Alert.alert(`${label} failed`, errorText(error)))
  }

  return (
    <Modal visible={projectId !== null} animationType="slide" onRequestClose={() => (viewingLogs ? setViewingLogs(null) : onClose())}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {viewingLogs && locationId ? (
          <LogViewer command={viewingLogs} locationId={locationId} onBack={() => setViewingLogs(null)} />
        ) : (
          <>
            <View style={styles.header}>
              <Pressable onPress={onClose} hitSlop={10}>
                <Text style={styles.closeIcon}>✕</Text>
              </Pressable>
              <Text style={styles.title}>Commands</Text>
              {loading ? <ActivityIndicator size="small" color={colors.claude} /> : null}
            </View>

            {locations && locations.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locationBar} contentContainerStyle={styles.locationRow}>
                {locations.map((location) => (
                  <Chip
                    key={location.id}
                    label={`${location.is_worktree ? '⎇ ' : ''}${location.label || location.path}`}
                    active={locationId === location.id}
                    onPress={() => setLocationId(location.id)}
                  />
                ))}
              </ScrollView>
            ) : null}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 10 }}>
              {commands.map((command) => {
                const status = statusByCommand[command.id]
                const ports = portsByCommand[command.id] ?? []
                const running = status === 'running'
                return (
                  <Pressable key={command.id} onPress={() => setViewingLogs(command)} style={styles.commandCard}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={[styles.statusDot, { backgroundColor: statusColor(status) }]} />
                      <Text style={styles.commandName} numberOfLines={1}>
                        {command.name}
                      </Text>
                      {ports.length > 0 ? <Text style={styles.ports}>:{ports.join(' :')}</Text> : null}
                    </View>
                    <Text style={styles.commandText} numberOfLines={1}>
                      {command.command}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {running ? (
                        <>
                          <Button small title="Stop" variant="danger" onPress={() => run('Stop', command.id, 'commands:stop')} style={{ flex: 1 }} />
                          <Button small title="Restart" variant="secondary" onPress={() => run('Restart', command.id, 'commands:restart')} style={{ flex: 1 }} />
                        </>
                      ) : (
                        <Button small title="Start" onPress={() => run('Start', command.id, 'commands:start')} style={{ flex: 1 }} />
                      )}
                      <Button small title="Logs" variant="secondary" onPress={() => setViewingLogs(command)} style={{ flex: 1 }} />
                    </View>
                  </Pressable>
                )
              })}
              {commands.length === 0 && !loading ? (
                <Text style={styles.empty}>No commands configured for this project (add them on the desktop).</Text>
              ) : null}
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
  closeIcon: { color: colors.text, fontSize: 18 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', flex: 1 },
  locationBar: { maxHeight: 46, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  commandCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  commandName: { color: colors.text, fontSize: 14.5, fontWeight: '600', flex: 1 },
  ports: { color: colors.info, fontSize: 12, fontFamily: 'monospace' },
  commandText: { color: colors.textMuted, fontSize: 12, fontFamily: 'monospace' },
  empty: { color: colors.textMuted, fontSize: 13.5, textAlign: 'center', paddingVertical: 24 },
  logHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backIcon: { color: colors.text, fontSize: 24, lineHeight: 26, marginTop: -3 },
  logTitle: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  logText: { color: '#c9d1d9', fontFamily: 'monospace', fontSize: 11.5, lineHeight: 17 },
})
