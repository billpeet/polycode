import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useProjectStore } from '../stores/projects'

const loadedFavicons = new Map<string, string | null>()

function ProjectFaviconContent({ projectId, cacheKey, className = '' }: { projectId: string; cacheKey: string; className?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(() => loadedFavicons.get(cacheKey))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (loadedFavicons.has(cacheKey)) return
    let cancelled = false
    void window.api.invoke('projects:favicon', projectId).then((value) => {
      if (cancelled) return
      loadedFavicons.set(cacheKey, value)
      setSrc(value)
    }).catch(() => {
      if (!cancelled) setSrc(null)
    })
    return () => { cancelled = true }
  }, [cacheKey, projectId])

  if (!src || failed) return <Folder className={`flex-shrink-0 opacity-50 ${className}`} aria-hidden />
  return <img src={src} alt="" className={`flex-shrink-0 rounded-sm object-contain ${className}`} onError={() => setFailed(true)} />
}

export default function ProjectFavicon(props: { projectId: string; className?: string }) {
  const faviconPath = useProjectStore((state) => state.projects.find((project) => project.id === props.projectId)?.favicon_path ?? null)
  const cacheKey = `${props.projectId}:${faviconPath ?? ''}`
  return <ProjectFaviconContent key={cacheKey} cacheKey={cacheKey} {...props} />
}
