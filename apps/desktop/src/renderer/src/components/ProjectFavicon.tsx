import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'

const loadedFavicons = new Map<string, string | null>()

function ProjectFaviconContent({ projectId, className = '' }: { projectId: string; className?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(() => loadedFavicons.get(projectId))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (loadedFavicons.has(projectId)) return
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

export default function ProjectFavicon(props: { projectId: string; className?: string }) {
  return <ProjectFaviconContent key={props.projectId} {...props} />
}
