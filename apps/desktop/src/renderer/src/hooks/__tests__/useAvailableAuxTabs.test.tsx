// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// stores/plans.ts subscribes to plan:associated at import time. ESM hoists the
// imports below above ordinary statements, so the stub has to be installed in a
// hoisted block to land before the module graph is evaluated.
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = {
    ...(globalThis as { window?: object }).window,
    api: { invoke: () => Promise.resolve(null), on: () => () => {} },
  }
})

import { useAvailableAuxTabs, type AuxTab } from '../useAvailableAuxTabs'
import { useUiStore } from '../../stores/ui'
import { useThreadStore } from '../../stores/threads'
import { useFilesStore } from '../../stores/files'
import { useTerminalStore } from '../../stores/terminal'
import { usePlanStore } from '../../stores/plans'

const THREAD_ID = 'thread-1'
const LOCATION_ID = 'loc-1'

function captureTabs(): AuxTab[] {
  let captured: AuxTab[] = []
  function Probe(): ReactNode {
    captured = useAvailableAuxTabs(THREAD_ID).tabs
    return null
  }
  render(<Probe />)
  return captured
}

describe('useAvailableAuxTabs', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { ...window, api: { invoke: vi.fn(), on: vi.fn(() => () => {}) } })

    useUiStore.setState({
      layoutMode: 'split',
      chatTabActiveByThread: {},
      activeAuxTabByThread: {},
      locationAuxTabByLocation: {},
      locationAuxTabRequestByLocation: {},
    })
    useThreadStore.setState({
      selectedThreadId: THREAD_ID,
      byProject: { 'proj-1': [{ id: THREAD_ID, location_id: LOCATION_ID }] },
    } as never)
    useFilesStore.setState({
      selectedFilePathByLocation: {},
      diffViewByLocation: {},
      loadingDiffByLocation: {},
    } as never)
    useTerminalStore.setState({ visibleByLocation: {} } as never)
    usePlanStore.setState({ visibleByThread: {}, planByThread: {} } as never)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('offers no tabs in split layout when nothing is open', () => {
    // The panel collapses entirely rather than showing an empty shell.
    expect(captureTabs()).toEqual([])
  })

  it('offers the chat tab alone in full layout when nothing else is open', () => {
    useUiStore.setState({ layoutMode: 'full' })

    expect(captureTabs()).toEqual(['chat'])
  })

  it('never offers a chat tab in split layout, where the chat has its own pane', () => {
    useTerminalStore.setState({ visibleByLocation: { [LOCATION_ID]: true } } as never)

    expect(captureTabs()).toEqual(['terminal'])
  })

  it('keeps chat out of the split-layout tab bar even with several panes open', () => {
    // Regression: chat briefly showed as a tab in split view, where it already
    // has a dedicated pane and a tab for it is meaningless.
    useTerminalStore.setState({ visibleByLocation: { [LOCATION_ID]: true } } as never)
    useFilesStore.setState({ selectedFilePathByLocation: { [LOCATION_ID]: '/a.ts' } } as never)
    usePlanStore.setState({
      visibleByThread: { [THREAD_ID]: true },
      planByThread: { [THREAD_ID]: { text: 'plan' } },
    } as never)

    expect(captureTabs()).not.toContain('chat')
  })

  it('puts chat first so its position is stable as other panes come and go', () => {
    useUiStore.setState({ layoutMode: 'full' })
    useTerminalStore.setState({ visibleByLocation: { [LOCATION_ID]: true } } as never)
    useFilesStore.setState({ selectedFilePathByLocation: { [LOCATION_ID]: '/a.ts' } } as never)

    const tabs = captureTabs()

    expect(tabs[0]).toBe('chat')
    expect(tabs).toContain('file')
    expect(tabs).toContain('terminal')
  })

  it('derives a tab from each pane that has content', () => {
    useUiStore.setState({ layoutMode: 'full' })
    usePlanStore.setState({
      visibleByThread: { [THREAD_ID]: true },
      planByThread: { [THREAD_ID]: { text: 'do the thing' } },
    } as never)

    expect(captureTabs()).toEqual(['chat', 'plan'])
  })
})
