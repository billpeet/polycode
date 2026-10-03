import { Monitor, Server } from 'lucide-react'
import { LOCAL_SOURCE_ID, type UnifiedSource } from '@polycode/shared'
import { useUnifiedStore } from '../stores/unified'

/**
 * How a source (this desktop, or a Remote Host) is identified on screen in the unified
 * view: one stable colour and label per source, used by the sidebar pills, the composer's
 * destination picker and the open Thread's header alike.
 */

const REMOTE_COLORS = ['#a78bfa', '#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#2dd4bf']
const LOCAL_COLOR = '#94a3b8'

/** Colour by position among the remote sources, so it is stable while the host list is. */
export function sourceColor(sourceId: string, sources: Pick<UnifiedSource, 'sourceId'>[]): string {
  if (sourceId === LOCAL_SOURCE_ID) return LOCAL_COLOR
  const index = sources.filter((s) => s.sourceId !== LOCAL_SOURCE_ID).findIndex((s) => s.sourceId === sourceId)
  return REMOTE_COLORS[(index < 0 ? 0 : index) % REMOTE_COLORS.length]
}

/** Compact inline pill for list rows. */
export function SourcePill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="ml-1 flex-shrink-0 truncate rounded px-1 text-[9px] font-semibold uppercase leading-[14px]"
      style={{ maxWidth: 90, color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
      title={label}
    >
      {label}
    </span>
  )
}

export interface ActiveSourceInfo {
  sourceId: string
  label: string
  color: string
  isLocal: boolean
}

/**
 * The source the workspace is currently pointed at, while the unified view is on.
 * Null in single-source mode, where the title-bar switcher already says it.
 */
export function useActiveSource(): ActiveSourceInfo | null {
  const enabled = useUnifiedStore((s) => s.enabled)
  const sourceId = useUnifiedStore((s) => s.activeSourceId)
  const sources = useUnifiedStore((s) => s.snapshot?.sources)
  if (!enabled) return null
  const isLocal = sourceId === LOCAL_SOURCE_ID
  const label = sources?.find((s) => s.sourceId === sourceId)?.label ?? (isLocal ? 'Local' : 'Remote host')
  return { sourceId, label, color: sourceColor(sourceId, sources ?? []), isLocal }
}

/**
 * The prominent form: icon, label and a tinted, bordered chip. Used where it must be
 * unmistakable which machine a Thread runs on.
 */
export function SourceBadge({ source, size = 'md' }: { source: ActiveSourceInfo; size?: 'sm' | 'md' }) {
  const Icon = source.isLocal ? Monitor : Server
  const small = size === 'sm'
  return (
    <span
      className={`flex flex-shrink-0 items-center gap-1 rounded font-semibold uppercase tracking-wide ${small ? 'px-1.5 text-[10px] leading-[18px]' : 'px-2 py-0.5 text-[11px]'}`}
      style={{
        color: source.color,
        background: `color-mix(in srgb, ${source.color} 18%, transparent)`,
        border: `1px solid color-mix(in srgb, ${source.color} 45%, transparent)`,
        maxWidth: 180,
      }}
      title={source.isLocal ? 'This thread runs on this machine' : `This thread runs on the remote host "${source.label}"`}
    >
      <Icon size={small ? 10 : 12} className="flex-shrink-0" />
      <span className="truncate">{source.label}</span>
    </span>
  )
}
