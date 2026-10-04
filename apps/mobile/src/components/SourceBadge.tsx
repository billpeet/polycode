import { StyleSheet, Text, View } from 'react-native'
import { useHostsStore } from '@/stores/hosts'
import { useUnifiedStore } from '@/stores/unified'
import { colors } from '@/theme/colors'

/**
 * How a host is identified on screen in the unified ("All") view: one stable colour and
 * its label, the same in the Queue, the tree and the New-thread sheet. The palette is
 * the desktop's remote-source one.
 */
const SOURCE_COLORS = ['#a78bfa', '#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#2dd4bf']

/** Colour by position among the saved hosts, so it is stable while the host list is. */
function useSourceColor(sourceId: string): string {
  const index = useHostsStore((s) => s.hosts.findIndex((host) => host.id === sourceId))
  return SOURCE_COLORS[(index < 0 ? 0 : index) % SOURCE_COLORS.length]
}

/** Compact pill naming the host a row belongs to. */
export function SourcePill(props: { sourceId: string; label: string }) {
  const color = useSourceColor(props.sourceId)
  return (
    <View style={[styles.pill, { backgroundColor: `${color}29` }]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  )
}

/**
 * Names the hosts the unified view could not read, so an absent Project reads as "that
 * machine is unreachable" rather than "that Project is gone". Renders nothing when every
 * host answered.
 */
export function UnreachableSources() {
  const sources = useUnifiedStore((s) => s.snapshot?.sources)
  const unreachable = sources?.filter((source) => source.status === 'error') ?? []
  if (unreachable.length === 0) return null
  return (
    <View style={styles.banner}>
      {unreachable.map((source) => (
        <Text key={source.sourceId} style={styles.bannerText} numberOfLines={1}>
          ⚠ {source.label} unreachable{source.error ? ` — ${source.error}` : ''}
        </Text>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  pill: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1, maxWidth: 110, flexShrink: 0 },
  pillText: { fontSize: 9.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  banner: {
    marginHorizontal: 12,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.35)',
    backgroundColor: 'rgba(251, 191, 36, 0.08)',
    gap: 2,
  },
  bannerText: { color: colors.warning, fontSize: 12 },
})
