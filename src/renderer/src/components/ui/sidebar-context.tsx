import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

const SIDEBAR_WIDTH = '240px'
const SIDEBAR_WIDTH_COLLAPSED = '48px'
const COLLAPSE_BREAKPOINT = 900

type SidebarState = 'expanded' | 'collapsed'

interface SidebarContextValue {
  state: SidebarState
  isCollapsed: boolean
  toggle: () => void
  expand: () => void
  collapse: () => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function useSidebar() {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}

export const SIDEBAR_CSS_VARS = {
  '--sidebar-width': SIDEBAR_WIDTH,
  '--sidebar-width-collapsed': SIDEBAR_WIDTH_COLLAPSED,
} as React.CSSProperties

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidebarState>(() =>
    window.innerWidth < COLLAPSE_BREAKPOINT ? 'collapsed' : 'expanded'
  )

  // Auto-collapse on resize
  useEffect(() => {
    let prev = window.innerWidth
    function onResize() {
      const w = window.innerWidth
      if (prev >= COLLAPSE_BREAKPOINT && w < COLLAPSE_BREAKPOINT) {
        setState('collapsed')
      } else if (prev < COLLAPSE_BREAKPOINT && w >= COLLAPSE_BREAKPOINT) {
        setState('expanded')
      }
      prev = w
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const toggle = useCallback(() => setState((s) => (s === 'expanded' ? 'collapsed' : 'expanded')), [])
  const expand = useCallback(() => setState('expanded'), [])
  const collapse = useCallback(() => setState('collapsed'), [])

  return (
    <SidebarContext.Provider value={{ state, isCollapsed: state === 'collapsed', toggle, expand, collapse }}>
      {children}
    </SidebarContext.Provider>
  )
}
