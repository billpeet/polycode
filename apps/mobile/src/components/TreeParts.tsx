import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RepoLocation, Thread } from '@polycode/shared'
import { groupThreadsByLocation, locationLabel } from '@/lib/locations'
import { colors, radii, sectionLabel } from '@/theme/colors'
import { ThreadStatusIndicator } from './StatusDot'

/** Rows and styles shared by the single-host tree and the unified ("All") tree. */

function ThreadRow(props: { thread: Thread; onPress: () => void; onLongPress: () => void }) {
  const { thread } = props
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      style={({ pressed }) => [treeStyles.threadRow, pressed && { opacity: 0.7 }]}
    >
      <ThreadStatusIndicator status={thread.status} unread={thread.unread} size={7} />
      <Text style={[treeStyles.threadName, thread.unread && { fontWeight: '700', color: '#ffffff' }]} numberOfLines={1}>
        {thread.name}
      </Text>
      {thread.unread ? <View style={treeStyles.unreadDot} /> : null}
    </Pressable>
  )
}

/** A Project's Threads: flat, or under Location headers when it has several Locations. */
export function ThreadSections(props: {
  locations: RepoLocation[] | undefined
  threads: Thread[]
  onThreadPress: (thread: Thread) => void
  onThreadLongPress: (thread: Thread) => void
  onLocationLongPress: (location: RepoLocation) => void
}) {
  const row = (thread: Thread) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      onPress={() => props.onThreadPress(thread)}
      onLongPress={() => props.onThreadLongPress(thread)}
    />
  )
  const grouped = groupThreadsByLocation(props.locations, props.threads)
  if (!grouped) return <>{props.threads.map(row)}</>
  return (
    <>
      {grouped.map((section, index) => {
        const { location } = section
        return (
          <View key={location?.id ?? `other-${index}`}>
            <Pressable
              style={treeStyles.locationHeader}
              onLongPress={() => location && props.onLocationLongPress(location)}
            >
              <Text style={treeStyles.locationLabel} numberOfLines={1}>
                {location ? locationLabel(location) : 'Other'}
              </Text>
            </Pressable>
            {section.threads.map(row)}
          </View>
        )
      })}
    </>
  )
}

/** A muted or accented text row under a Project's Threads (`＋ New thread`, `Archived (3)`). */
export function TreeLink(props: { label: string; accent?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => [treeStyles.linkRow, pressed && { opacity: 0.7 }]}>
      <Text style={props.accent ? treeStyles.linkAccent : treeStyles.linkMuted}>{props.label}</Text>
    </Pressable>
  )
}

export const treeStyles = StyleSheet.create({
  // Room for the floating New-thread button over the last row.
  list: { padding: 12, paddingBottom: 96, gap: 8 },
  projectCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  projectChevron: { color: colors.textMuted, fontSize: 11, width: 12 },
  projectChevronOpen: { transform: [{ rotate: '90deg' }] },
  projectName: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  runningDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  threadList: { paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.border },
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 30,
    paddingRight: 12,
    paddingVertical: 9,
  },
  threadName: { color: colors.textMuted, fontSize: 13, flex: 1 },
  unreadDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  linkRow: { paddingLeft: 30, paddingVertical: 7 },
  linkAccent: { color: colors.accent, fontSize: 12.5, fontWeight: '500' },
  linkMuted: { color: colors.textMuted, fontSize: 12.5, fontWeight: '500' },
  emptyText: { color: colors.textMuted, fontSize: 13, padding: 16 },
  locationHeader: { paddingLeft: 24, paddingTop: 8, paddingBottom: 2 },
  locationLabel: { ...sectionLabel, opacity: 0.8 },
})
