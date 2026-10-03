import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import { sourceKey, useUnifiedStore } from '../stores/unified'
import ProjectFavicon from './ProjectFavicon'

const remoteFavicons = new Map<string, string | null>()

/**
 * Favicon for a Project on any source. The active source goes through the ordinary
 * component (and its cache); other sources are asked directly, without switching to them.
 */
export default function SourceProjectFavicon({
  sourceId,
  projectId,
  active,
  className = 'mr-1.5 h-3.5 w-3.5',
}: {
  sourceId: string
  projectId: string
  active: boolean
  className?: string
}) {
  const key = sourceKey(sourceId, projectId)
  const [src, setSrc] = useState<string | null | undefined>(() => remoteFavicons.get(key))
  useEffect(() => {
    if (active || remoteFavicons.has(key)) return
    let cancelled = false
    void useUnifiedStore.getState().invokeOn(sourceId, 'projects:favicon', projectId)
      .catch(() => null)
      .then((value) => {
        remoteFavicons.set(key, value)
        if (!cancelled) setSrc(value)
      })
    return () => { cancelled = true }
  }, [active, key, sourceId, projectId])
  if (active) return <ProjectFavicon projectId={projectId} className={className} />
  if (!src) return <Folder className={`${className} flex-shrink-0 opacity-50`} aria-hidden />
  return <img src={src} alt="" className={`${className} flex-shrink-0 rounded-sm object-contain`} />
}
