import type { CSSProperties } from 'react'

/**
 * Style for an aux pane that stays mounted while another tab is showing.
 *
 * Terminal and Browser cannot be unmounted when they lose the tab bar — that
 * would kill the PTY and reload the guest pages — so they are hidden by being
 * collapsed to zero height instead.
 *
 * The hidden basis must be a *definite* length. The obvious `flex: 0` expands
 * to `flex-basis: 0%`, and a percentage basis resolved against an indefinite
 * container height falls back to the content size. SecondPanel's height is
 * exactly that — `auto` — in full layout with the Chat tab selected, and
 * flex-basis outranks `height: 0`, so the hidden pane reserved its content's
 * height (a <webview> defaults to 300px) and pushed the chat pane down the
 * window. `0px` has no such fallback.
 */
export function auxPaneStyle(visible: boolean): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    flex: visible ? '1 1 0%' : '0 0 0px',
    height: visible ? 'auto' : 0,
    minHeight: 0,
  }
}
