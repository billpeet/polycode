import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WebviewTag,
  DidFailLoadEvent,
  DidNavigateEvent,
  DidNavigateInPageEvent,
  PageTitleUpdatedEvent,
  PageFaviconUpdatedEvent,
} from 'electron'
import { useBrowserStore, type BrowserTab } from '../stores/browser'
import type { BrowserSessionConfig } from '../types/ipc'
import { normalizeBrowserUrl } from '../../../shared/browser'

interface Props {
  locationId: string
}

// ─── Per-tab guest ────────────────────────────────────────────────────────────

interface TabViewProps {
  locationId: string
  tab: BrowserTab
  session: BrowserSessionConfig
  active: boolean
  onWebview: (tabId: string, el: WebviewTag | null) => void
}

/**
 * One mounted <webview> per tab. Inactive tabs stay mounted at height 0 so
 * switching browser tabs never reloads the page — the same trick the terminal
 * uses to preserve its PTY.
 */
function BrowserTabView({ locationId, tab, session, active, onWebview }: TabViewProps) {
  const updateTab = useBrowserStore((s) => s.updateTab)
  const webviewRef = useRef<WebviewTag | null>(null)

  const retry = (): void => {
    updateTab(locationId, tab.id, { error: null, loading: true })
    webviewRef.current?.reload()
  }

  // src is the *initial* navigation only; every later navigation goes through
  // loadURL from the toolbar. Letting React rewrite the src attribute on each
  // url change would navigate the guest a second time on top of the explicit
  // loadURL call.
  const [initialSrc] = useState(tab.url)

  useEffect(() => {
    const el = webviewRef.current
    if (!el) return
    onWebview(tab.id, el)
    return () => onWebview(tab.id, null)
    // Re-runs when the guest first mounts (url flips from null), so the
    // element lands in the toolbar's registry.
  }, [tab.id, tab.url, onWebview])

  useEffect(() => {
    const el = webviewRef.current
    if (!el) return

    const onStart = (): void => updateTab(locationId, tab.id, { loading: true, error: null })
    const onStop = (): void => updateTab(locationId, tab.id, {
      loading: false,
      url: el.getURL() || tab.url,
      canGoBack: el.canGoBack(),
      canGoForward: el.canGoForward(),
    })
    const onNavigate = (e: DidNavigateEvent): void => updateTab(locationId, tab.id, {
      url: e.url,
      error: null,
      canGoBack: el.canGoBack(),
      canGoForward: el.canGoForward(),
    })
    const onNavigateInPage = (e: DidNavigateInPageEvent): void => {
      if (!e.isMainFrame) return
      updateTab(locationId, tab.id, {
        url: e.url,
        canGoBack: el.canGoBack(),
        canGoForward: el.canGoForward(),
      })
    }
    const onTitle = (e: PageTitleUpdatedEvent): void =>
      updateTab(locationId, tab.id, { title: e.title })
    const onFavicon = (e: PageFaviconUpdatedEvent): void =>
      updateTab(locationId, tab.id, { faviconUrl: e.favicons[e.favicons.length - 1] ?? null })
    const onFailLoad = (e: DidFailLoadEvent): void => {
      // -3 (ERR_ABORTED) is a superseded navigation, not a failure.
      if (!e.isMainFrame || e.errorCode === -3) return
      updateTab(locationId, tab.id, { loading: false, error: e.errorDescription || `Error ${e.errorCode}` })
    }
    const onCrash = (): void =>
      updateTab(locationId, tab.id, { loading: false, error: 'The page crashed' })

    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigateInPage)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('page-favicon-updated', onFavicon)
    el.addEventListener('did-fail-load', onFailLoad)
    el.addEventListener('render-process-gone', onCrash)

    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigateInPage)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('page-favicon-updated', onFavicon)
      el.removeEventListener('did-fail-load', onFailLoad)
      el.removeEventListener('render-process-gone', onCrash)
    }
  }, [locationId, tab.id, tab.url, updateTab])

  if (!initialSrc) {
    // New-tab page: no guest process until the first navigation.
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{
          display: active ? 'flex' : 'none',
          background: 'var(--color-surface)',
        }}
      >
        <div className="text-center px-8" style={{ color: 'var(--color-text-muted)' }}>
          <p className="text-sm mb-2">Open a page from this location</p>
          <p className="text-xs leading-relaxed">
            {session.proxied
              ? <>localhost traffic is tunneled to <b>{session.sshLabel}</b> —{'\n'}e.g. <code>localhost:5173</code> reaches the dev server on the session host.</>
              : <>Type a URL above, e.g. <code>localhost:5173</code> for a local dev server.</>}
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <webview
        ref={webviewRef}
        src={initialSrc}
        partition={session.partition}
        allowpopups={true}
        className="flex-1"
        style={{
          display: active ? 'flex' : 'none',
          width: '100%',
          minHeight: 0,
          backgroundColor: '#ffffff',
        }}
      />
      {tab.error && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
          style={{ background: 'var(--color-surface)', zIndex: 1 }}
        >
          <p className="text-sm" style={{ color: 'var(--color-text)' }}>
            Couldn&apos;t load this page
          </p>
          <p className="text-xs max-w-[90%] break-words" style={{ color: 'var(--color-text-muted)' }}>
            {tab.error}
            {session.proxied && (
              <>{' '}— check that the dev server is still running on the session host.</>
            )}
          </p>
          <button
            onClick={retry}
            className="text-xs rounded-md px-3 py-1.5 hover:opacity-80"
            style={{
              background: 'rgba(232, 123, 95, 0.15)',
              color: 'var(--color-claude)',
              border: '1px solid rgba(232, 123, 95, 0.3)',
            }}
          >
            Retry
          </button>
        </div>
      )}
    </>
  )
}

// ─── Panel content ────────────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded p-1.5 hover:bg-white/10 transition-colors flex-shrink-0 disabled:opacity-30 disabled:hover:bg-transparent"
      style={{ color: 'var(--color-text-muted)' }}
      title={title}
    >
      {children}
    </button>
  )
}

export default function BrowserContent({ locationId }: Props) {
  const tabs = useBrowserStore((s) => s.tabsByLocation[locationId])
  const activeId = useBrowserStore((s) => s.activeByLocation[locationId])
  const session = useBrowserStore((s) => s.sessionByLocation[locationId])
  const closePanel = useBrowserStore((s) => s.closePanel)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const activateTab = useBrowserStore((s) => s.activateTab)
  const newTab = useBrowserStore((s) => s.newTab)
  const updateTab = useBrowserStore((s) => s.updateTab)

  // Webview elements by tab id, so the toolbar can drive the active one.
  const webviews = useRef(new Map<string, WebviewTag>())
  const onWebview = useCallback((tabId: string, el: WebviewTag | null) => {
    if (el) webviews.current.set(tabId, el)
    else webviews.current.delete(tabId)
  }, [])

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null

  // URL bar is an editable field; resync whenever the active tab navigates.
  const [urlInput, setUrlInput] = useState('')
  const lastCommittedUrl = useRef<string | null>(null)
  useEffect(() => {
    if (activeTab?.url !== lastCommittedUrl.current) {
      lastCommittedUrl.current = activeTab?.url ?? null
      setUrlInput(activeTab?.url ?? '')
    }
  }, [activeTab?.url])

  const navigate = (raw: string): void => {
    const url = normalizeBrowserUrl(raw)
    if (!url || !activeTab) return
    const el = webviews.current.get(activeTab.id)
    if (el) {
      // Mounted guest: loadURL drives the navigation (src stays at its
      // initial value, so no duplicate navigation from a React re-render).
      el.loadURL(url).catch(() => { /* did-fail-load reports it */ })
      updateTab(locationId, activeTab.id, { url, loading: true, error: null })
    } else {
      // New tab: setting url mounts the guest with this src.
      updateTab(locationId, activeTab.id, { url, loading: true, error: null })
    }
  }

  const withActiveWebview = (action: (el: WebviewTag) => void): void => {
    if (!activeTab) return
    const el = webviews.current.get(activeTab.id)
    if (el) action(el)
  }

  if (!session) return null

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <span
          className="text-xs font-semibold rounded px-1.5 py-0.5"
          style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--color-text-muted)' }}
        >
          Browser
        </span>
        {session.proxied && (
          <span
            className="text-[10px] font-mono rounded px-1.5 py-0.5"
            style={{ color: '#4ade80', background: 'rgba(74, 222, 128, 0.12)' }}
            title={`localhost traffic is tunneled to ${session.sshLabel}`}
          >
            via {session.sshLabel}
          </span>
        )}
        <span className="flex-1" />
        <ToolbarButton onClick={() => closePanel(locationId)} title="Close browser">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </ToolbarButton>
      </div>

      {/* Tab strip */}
      <div
        className="flex items-center gap-1 px-2 pt-1.5 overflow-x-auto flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId
          return (
            <div
              key={tab.id}
              onClick={() => activateTab(locationId, tab.id)}
              className="group flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-md cursor-pointer max-w-[180px] flex-shrink-0"
              style={{
                background: isActive ? 'rgba(232, 123, 95, 0.12)' : 'transparent',
                borderBottom: isActive ? '2px solid var(--color-claude)' : '2px solid transparent',
              }}
              title={tab.url ?? 'New Tab'}
            >
              {tab.loading ? (
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0 animate-spin"
                  style={{ border: '1.5px solid var(--color-text-muted)', borderTopColor: 'transparent' }}
                />
              ) : tab.faviconUrl ? (
                <img src={tab.faviconUrl} className="w-3 h-3 flex-shrink-0" alt="" />
              ) : (
                <span className="w-2 h-2 flex-shrink-0" />
              )}
              <span
                className="text-xs truncate"
                style={{ color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)' }}
              >
                {tab.title || tab.url || 'New Tab'}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(locationId, tab.id)
                }}
                className="rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-white/10 flex-shrink-0"
                style={{ color: 'var(--color-text-muted)' }}
                title="Close tab"
              >
                <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
                </svg>
              </button>
            </div>
          )
        })}
        <button
          onClick={() => void newTab(locationId, null)}
          className="rounded p-1 hover:bg-white/10 transition-colors flex-shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title="New tab"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z" />
          </svg>
        </button>
      </div>

      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-2 py-1.5 border-b flex-shrink-0"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <ToolbarButton
          onClick={() => withActiveWebview((el) => el.goBack())}
          disabled={!activeTab?.canGoBack}
          title="Back"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.5 3L5.5 8l5 5" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => withActiveWebview((el) => el.goForward())}
          disabled={!activeTab?.canGoForward}
          title="Forward"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.5 3l5 5-5 5" />
          </svg>
        </ToolbarButton>
        {activeTab?.loading ? (
          <ToolbarButton onClick={() => withActiveWebview((el) => el.stop())} title="Stop">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="10" height="10" rx="1.5" />
            </svg>
          </ToolbarButton>
        ) : (
          <ToolbarButton onClick={() => withActiveWebview((el) => el.reload())} title="Reload">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
              <path d="M13.5 1.5v3h-3" />
            </svg>
          </ToolbarButton>
        )}

        <form
          className="flex-1 flex items-center min-w-0"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(urlInput)
          }}
        >
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="Search or enter address"
            spellCheck={false}
            className="flex-1 min-w-0 text-xs rounded-md px-2.5 py-1.5 outline-none"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          />
        </form>

        <ToolbarButton
          onClick={() => {
            if (activeTab?.url) void window.api.invoke('shell:openExternal', activeTab.url)
          }}
          disabled={!activeTab?.url}
          title="Open in system browser"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.5" />
            <path d="M9.5 2H14v4.5" />
            <path d="M14 2L7.5 8.5" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => withActiveWebview((el) => el.openDevTools())}
          disabled={!activeTab?.url}
          title="DevTools"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 4L2 8l3 4" />
            <path d="M11 4l3 4-3 4" />
          </svg>
        </ToolbarButton>
      </div>

      {/* Guests — inactive tabs stay mounted at zero size to preserve page state */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="flex flex-col flex-1 overflow-hidden relative"
            style={{
              // 0px, not 0%: a percentage basis against an indefinite
              // container height falls back to the content size.
              flex: tab.id === activeId ? '1 1 0%' : '0 0 0px',
              height: tab.id === activeId ? 'auto' : 0,
              visibility: tab.id === activeId ? 'visible' : 'hidden',
            }}
          >
            {tab.url && (
              <BrowserTabView
                locationId={locationId}
                tab={tab}
                session={session}
                active={tab.id === activeId}
                onWebview={onWebview}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
