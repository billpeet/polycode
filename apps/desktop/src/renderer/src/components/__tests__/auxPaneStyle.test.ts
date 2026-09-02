import { describe, expect, it } from 'vitest'
import { auxPaneStyle } from '../auxPaneStyle'

describe('auxPaneStyle', () => {
  it('gives the visible pane the panel', () => {
    const style = auxPaneStyle(true)
    expect(style.flex).toBe('1 1 0%')
    expect(style.height).toBe('auto')
  })

  it('collapses a hidden pane to a definite zero basis', () => {
    // Regression: `flex: 0` (i.e. `flex-basis: 0%`) against SecondPanel's
    // `height: auto` — full layout with the Chat tab selected — is an
    // indefinite percentage, so the basis fell back to the content size and
    // outranked `height: 0`. The backgrounded Browser tab then reserved its
    // <webview>'s default 300px and left a blank band above the transcript.
    const style = auxPaneStyle(false)
    expect(style.flex).toBe('0 0 0px')
    expect(String(style.flex)).not.toContain('%')
    expect(style.height).toBe(0)
    expect(style.minHeight).toBe(0)
  })

  it('hides by collapsing, never by unmounting or display:none', () => {
    // The pane holds a live PTY or guest page; display:none would still be in
    // the tree but costs a relayout the guest cannot be trusted to survive.
    expect(auxPaneStyle(false).display).toBe('flex')
    expect(auxPaneStyle(false).overflow).toBe('hidden')
  })
})
