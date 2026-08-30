# Layout modes: split vs. full-page (Chat as a tab)

Add an app-wide layout toggle. **Split** keeps today's behaviour (chat left,
tabbed aux panel right). **Full** collapses to one full-width tabbed surface
where Chat is just another tab, so a command log or terminal can take the whole
window and you can flick back to Chat.

## The constraint that shapes the whole design

`SecondPanel` never unmounts its panes. Terminal and Browser are held mounted at
`height: 0` and only *look* hidden:

- `Terminal.tsx:115-124` — unmount calls `term.dispose()`; the PTY survives in
  main but all scrollback and the xterm instance are destroyed.
- `Browser.tsx:28-31` — "Inactive tabs stay mounted at height 0 so switching
  browser tabs never reloads the page"; unmounting destroys the `<webview>`
  guest, losing navigation history and any logged-in session.
- `ThreadView.tsx:90-291` — `ThreadViewContent` owns the `thread:output:*`,
  `thread:status:*`, `thread:complete:*` IPC subscriptions plus the todo/usage/
  rate-limit side effects. Mounting it twice for one thread **double-applies
  every event**; remounting it re-fetches and rebuilds todo state.

So the toggle must **not** render the panes into two different JSX subtrees
(`mode === 'split' ? <A/> : <B/>`). React would unmount and remount on every
toggle, resetting terminals, reloading browsers, and churning chat
subscriptions. **One subtree, always mounted; the mode changes only CSS.** This
is the single most important rule here — it is also why no resizable-panel
library is being introduced.

## Design

Both panes keep their current position in the tree in `App.tsx`. Mode changes
which one is visible and how wide it is:

Full mode shows exactly ONE surface at a time. The workspace flips from a flex
row to a flex column, so the aux tab bar stacks above whichever surface is
showing. The chat pane uses `order` (not DOM position) to sit below the bar, so
its element never moves in the tree and never remounts.

| | Split | Full, chat tab | Full, other tab |
|---|---|---|---|
| Workspace axis | row | column | column |
| Chat pane | `flex: 1` | `flex: 1` | `width/height: 0`, mounted |
| Aux panel | fixed width | tab bar only (`flex: 0 0 auto`) | `flex: 1` |
| Chat tab in aux tab bar | absent | present, first position |
| Aux panel when nothing open | `null` | renders, Chat tab only |

When Chat is the active tab in full mode, the aux panel renders **nothing** in
its body and un-hides the chat pane — the chat lives in one place only, and the
"Chat tab" is a control that reveals it. That avoids portalling `ThreadView` or
mounting it twice.

## Steps

### 1. `stores/ui.ts` — layout mode state

Follow the `sidebarViewMode` pattern exactly (`ui.ts:8-9, 20-32, 49-89`):
persisted to the SQLite `settings` table via `settings:get`/`settings:set`, not
localStorage.

```ts
export type LayoutMode = 'split' | 'full'
const LAYOUT_MODE_SETTING_KEY = 'layout:mode'
```

Add `layoutMode: 'split'` (default), `loadLayoutMode()` (validate raw is
`'split' | 'full'`), `setLayoutMode(mode)`, `toggleLayoutMode()`.

Also add the Chat tab's selection state, since in full mode Chat competes with
the derived tabs:

```ts
chatTabActiveByThread: Record<string, boolean>   // default true
setChatTabActive: (threadId, active) => void
```

Keyed per thread so switching threads doesn't strand you on a tab that thread
has no content for. Not persisted — it is view state, not a preference.

Call `loadLayoutMode()` where the other loaders are hydrated. Note the audit
found `loadSidebarViewMode`/`loadSidebarWidth` are called from `Sidebar.tsx`,
*not* `App.tsx`'s mount effect — put this one in `App.tsx`'s mount effect
alongside projects/threads/favourites, and consider moving the sidebar ones
there later for consistency (out of scope).

### 2. `components/SecondPanel.tsx` — accept Chat as a tab

- Add `'chat'` to the `Tab` union and `TAB_LABELS` (`:18`, `:25-32`). Leave
  `LocationAuxTab` in the store alone — nothing *requests* the chat tab the way
  stores request `'diff'`, so it needs no entry in that channel.
- In `availableTabs` (`:147-155`), unshift `'chat'` when `layoutMode === 'full'`
  so Chat leads the tab bar.
- Change the early return `if (availableTabs.length === 0) return null` (`:212`)
  to only bail in split mode. In full mode the panel must render even with just
  the Chat tab, otherwise toggling to full with nothing open shows an empty
  window.
- Keep `showTabs = availableTabs.length > 1` (`:217`) as-is. This already gives
  the agreed empty state: in full mode with nothing else open, Chat is the only
  tab and the bar hides itself.
- Width: in full mode drop the fixed `width`/`minWidth`/`flexShrink: 0` and the
  `ResizeHandle` (`:220-232`), using `flex: 1` instead.
- The six `prevHasX` auto-switch effects (`:160-195`) currently steal focus to a
  newly-opened pane. In full mode that is *desirable* (opening a diff should
  show it), but it must also clear the chat tab — set
  `setChatTabActive(threadId, false)` alongside each `setActiveTab(...)`.
  Cleanest: wrap in one `activateTab(tab)` helper that does both, and route all
  seven call sites (six effects + the `requestedAuxTab` effect at `:197-208`)
  through it.
- Body: when `currentTab === 'chat'`, render no body. Every existing
  `currentTab === X &&` guard already handles this.

### 3. `App.tsx` — one subtree, CSS-only switching

At the layout seam (`:366-388`), keep both children mounted and mode-switch
their style:

```tsx
<main className="flex flex-1 overflow-hidden">
  <div
    className="flex flex-col overflow-hidden"
    style={
      chatVisible
        ? { flex: 1 }
        : { flex: 0, width: 0, overflow: 'hidden' }   // mounted, not rendered
    }
  >
    <ThreadView threadId={selectedThreadId} />
  </div>
  <SecondPanel threadId={selectedThreadId} />
  {isTodoPanelOpen && <RightPanel threadId={selectedThreadId} />}
</main>
```

where `chatVisible = layoutMode === 'split' || chatTabActive`.

**Do not** hide the chat pane with `display: none`. `MessageStream` is
virtualized (`@tanstack/react-virtual`) with a module-level `heightCache`
invalidated on width change (`MessageStream.tsx:30-32`); measuring rows inside a
zero-size container poisons that cache with 0 heights. Use `width: 0` +
`overflow: hidden` so the element keeps a height, and verify on the first
toggle-back that message heights are intact. If the cache still corrupts, the
fallback is `position: absolute; visibility: hidden` off-screen at full width,
which preserves measurement. This is the one genuinely risky detail in the plan
— confirm it in the running app rather than by reasoning.

Keep the existing `Profiler` and `UiErrorBoundary` wrappers exactly where they
are; changing their position remounts their subtree.

### 4. Expand/retract control in the tab bar

The toggle lives in `SecondPanel`'s tab bar, not the thread header: it only
means anything when there are tabs to expand, and the tab bar is where those
tabs already are. Right-aligned via `ml-auto`, with outward arrows to expand and
inward arrows to retract.

Consequence: `showTabs` becomes `availableTabs.length > 1 || isFull`. In full
layout with only the Chat tab the bar must still render, otherwise the retract
button disappears and the keyboard shortcut is the only way back to split view.
This overrides the original "hide the bar when Chat is the only tab" rule —
being able to get back out matters more than the tidier empty state.

### 5. `App.tsx` — keyboard shortcuts

Extend the existing handler's if/else chain (`:101-225`, already gated on
`ctrlKey || metaKey`):

- **Ctrl+Shift+L** → `toggleLayoutMode()`. Chosen because Ctrl+L alone is
  unclaimed but conventionally "clear", and the chain's plain-letter branches
  (`t`, `w`, `k`) all guard on `!e.shiftKey`.
- **Ctrl+Tab / Ctrl+Shift+Tab** → cycle tabs in full mode. This needs the
  available-tab list, which today is computed *inside* `SecondPanel` (`:147-155`)
  and not visible to `App`. Rather than duplicate that derivation, lift the
  `availableTabs` computation into a `useAvailableAuxTabs(threadId)` hook in a
  new `hooks/useAvailableAuxTabs.ts`, and have both `SecondPanel` and the
  shortcut handler consume it. In split mode, let Ctrl+Tab fall through
  untouched.

Note that on Windows/Electron Ctrl+Tab is not reserved by the OS, but confirm it
is not swallowed by a focused xterm — `Terminal.tsx` attaches its own key
handling, so the shortcut may need to run on the capture phase or be excluded
while the terminal has focus.

## Testing

- `apps/desktop` uses vitest + `@testing-library/react`; existing renderer tests
  are in `components/__tests__` and `stores/__tests__`.
- Store unit test: default `'split'`, `loadLayoutMode` rejects a garbage value,
  `setLayoutMode` calls `settings:set`, `toggleLayoutMode` round-trips.
- `SecondPanel` test: in full mode with nothing open, renders the Chat tab and
  no tab bar; with a diff open, both tabs appear and Chat leads.
- **The regression that matters**: toggling split→full→split must not remount
  `ThreadView` / `Terminal`. Assert via a mount counter or by spying that
  `term.dispose()` is not called across a toggle. This is the invariant the
  whole design exists to protect, so it deserves an explicit test.
- Manual: open a terminal, type output, toggle to full and back — scrollback
  must survive. Same for a browser tab's page state, and for chat scroll
  position mid-history.
