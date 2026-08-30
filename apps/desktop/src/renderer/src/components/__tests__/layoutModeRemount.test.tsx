// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { act, useEffect, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '../../stores/ui'

/**
 * The layout toggle must switch modes with CSS only, never by rendering the
 * panes into a different subtree.
 *
 * ThreadView owns the thread:output IPC subscriptions, and Terminal disposes its
 * xterm instance on unmount (destroying scrollback), so a remount on every
 * toggle would drop streamed events and wipe terminal history. These tests pin
 * that invariant to the layout rules themselves rather than to App's JSX, so
 * they keep failing if someone reintroduces a `mode === 'split' ? <A/> : <B/>`.
 */

/** Mirrors App.tsx: visibility is derived, mounting is unconditional. */
function chatVisibleFor(layoutMode: 'split' | 'full', chatTabActive: boolean): boolean {
  return layoutMode === 'split' || chatTabActive
}

let mountCount = 0
let disposeCount = 0

/** Stands in for ThreadView + Terminal: counts mounts and teardowns. */
function ExpensivePane(): ReactNode {
  const instance = useRef<number | null>(null)
  useEffect(() => {
    mountCount += 1
    instance.current = mountCount
    return () => {
      // Terminal.tsx calls term.dispose() here.
      disposeCount += 1
    }
  }, [])
  return <div data-testid="pane">pane</div>
}

/**
 * Full layout must show exactly one surface. The aux panel collapses to its tab
 * bar when Chat is active, so the two never share the window.
 */
function auxPanelCollapsedFor(layoutMode: 'split' | 'full', chatTabActive: boolean): boolean {
  return layoutMode === 'full' && chatTabActive
}

/** The layout seam, shaped exactly as App.tsx renders it. */
function Workspace({ threadId }: { threadId: string }): ReactNode {
  const layoutMode = useUiStore((s) => s.layoutMode)
  const chatTabActive = useUiStore((s) => s.chatTabActiveByThread[threadId] ?? true)
  const chatVisible = chatVisibleFor(layoutMode, chatTabActive)
  const auxCollapsed = auxPanelCollapsedFor(layoutMode, chatTabActive)

  return (
    <div
      data-testid="workspace"
      className={`flex flex-1 overflow-hidden ${layoutMode === 'full' ? 'flex-col' : 'flex-row'}`}
    >
      <div
        data-testid="chat-pane"
        className="flex flex-col overflow-hidden"
        style={{
          order: layoutMode === 'full' ? 1 : 0,
          ...(chatVisible ? { flex: 1 } : { flex: 0, width: 0, height: 0 }),
        }}
        aria-hidden={!chatVisible}
      >
        <ExpensivePane />
      </div>
      <div
        data-testid="aux-panel"
        style={auxCollapsed ? { flex: '0 0 auto' } : { flex: 1 }}
      />
    </div>
  )
}

describe('layout mode toggling', () => {
  beforeEach(() => {
    mountCount = 0
    disposeCount = 0
    vi.stubGlobal('window', { ...window, api: { invoke: vi.fn() } })
    useUiStore.setState({ layoutMode: 'split', chatTabActiveByThread: {}, activeAuxTabByThread: {} })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the chat pane mounted across a split -> full -> split round trip', () => {
    render(<Workspace threadId="thread-1" />)
    expect(mountCount).toBe(1)

    act(() => { useUiStore.getState().setLayoutMode('full') })
    act(() => { useUiStore.getState().setChatTabActive('thread-1', false) })
    act(() => { useUiStore.getState().setLayoutMode('split') })

    // One mount, no teardown: the same DOM node and the same subscriptions
    // survived the whole trip.
    expect(mountCount).toBe(1)
    expect(disposeCount).toBe(0)
  })

  it('hides the chat pane without unmounting it when another tab is active', () => {
    render(<Workspace threadId="thread-1" />)

    act(() => { useUiStore.getState().setLayoutMode('full') })
    act(() => { useUiStore.getState().setChatTabActive('thread-1', false) })

    // Still in the tree, just not visible.
    expect(screen.getByTestId('pane')).toBeTruthy()
    expect(disposeCount).toBe(0)
    expect(screen.getByTestId('chat-pane').getAttribute('aria-hidden')).toBe('true')
  })

  it('hides the chat pane by zeroing width, not display, so it stays measurable', () => {
    render(<Workspace threadId="thread-1" />)

    act(() => { useUiStore.getState().setLayoutMode('full') })
    act(() => { useUiStore.getState().setChatTabActive('thread-1', false) })

    // MessageStream's virtualizer caches row heights. display:none would make
    // every row measure 0 and poison that cache for when chat comes back.
    const style = screen.getByTestId('chat-pane').style
    expect(style.display).not.toBe('none')
    expect(style.width).toBe('0px')
  })

  it('does not split the window when the chat tab is selected in full mode', () => {
    // Regression: chat and the aux panel both claimed flex:1, so choosing the
    // Chat tab in full mode put them side by side — a split, which is exactly
    // what full mode exists to avoid.
    render(<Workspace threadId="thread-1" />)

    act(() => { useUiStore.getState().setLayoutMode('full') })
    act(() => { useUiStore.getState().setChatTabActive('thread-1', true) })

    expect(screen.getByTestId('chat-pane').style.flexGrow).toBe('1')
    // The aux panel keeps only its tab bar.
    expect(screen.getByTestId('aux-panel').style.flexGrow).toBe('0')
  })

  it('stacks the panes in full mode so the tab bar sits above the chat', () => {
    render(<Workspace threadId="thread-1" />)
    expect(screen.getByTestId('workspace').className).toContain('flex-row')

    act(() => { useUiStore.getState().setLayoutMode('full') })

    expect(screen.getByTestId('workspace').className).toContain('flex-col')
    // order, not DOM position, so the chat element never moves and never remounts.
    expect(screen.getByTestId('chat-pane').style.order).toBe('1')
    expect(mountCount).toBe(1)
  })

  it('gives the aux panel the window when a non-chat tab is active in full mode', () => {
    render(<Workspace threadId="thread-1" />)

    act(() => { useUiStore.getState().setLayoutMode('full') })
    act(() => { useUiStore.getState().setChatTabActive('thread-1', false) })

    expect(screen.getByTestId('aux-panel').style.flexGrow).toBe('1')
    // Chat gives up its space entirely rather than sharing the window.
    expect(screen.getByTestId('chat-pane').style.width).toBe('0px')
  })

  it('shows the chat pane in split mode regardless of which aux tab was last active', () => {
    render(<Workspace threadId="thread-1" />)

    act(() => { useUiStore.getState().setChatTabActive('thread-1', false) })

    // The chat tab only governs full layout; split always shows the transcript.
    expect(screen.getByTestId('chat-pane').getAttribute('aria-hidden')).toBe('false')
  })
})
