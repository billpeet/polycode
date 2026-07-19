import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'

const loadedFavicons = new Map<string, string | null>()

export default function ProjectFavicon({ projectId, className = '' }: { projectId: string; className?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(() => loadedFavicons.get(projectId))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    if (loadedFavicons.has(projectId)) {
      setSrc(loadedFavicons.get(projectId))
      return
    }
    let cancelled = false
    void window.api.invoke('projects:favicon', projectId).then((value) => {
      if (cancelled) return
      if (value) loadedFavicons.set(projectId, value)
      setSrc(value)
    }).catch(() => {
      if (!cancelled) setSrc(null)
    })
    return () => { cancelled = true }
  }, [projectId])

  if (!src || failed) return <Folder className={`flex-shrink-0 opacity-50 ${className}`} aria-hidden />
  return <img src={src} alt="" className={`flex-shrink-0 rounded-sm object-contain ${className}`} onError={() => setFailed(true)} />
}
