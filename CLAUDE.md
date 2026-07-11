# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# PolyCode — Claude Notes

## Monorepo Layout

Bun workspaces monorepo (hoisted linker forced in root `bunfig.toml` — the isolated linker breaks electron-builder packaging and phantom-dep resolution):

- **`apps/desktop`** — the Electron desktop app (package name `polycode-electron`; do NOT rename it — the Electron userData dir, and therefore every user's SQLite DB path, derives from it).
- **`apps/mobile`** — Expo (React Native) app for remote-controlling desktop instances over the remote-control HTTP/SSE API.
- **`packages/shared`** — `@polycode/shared`: dependency-free TS source shared by both apps (domain types, message-merge and todo-extraction logic). Consumed as raw TS; no build step.

## Commands

Run from the repo root (they proxy into `apps/desktop` unless noted):

```bash
bun run dev          # Desktop dev server with hot-reload (Vite + Electron)
bun run build        # Desktop production build into apps/desktop/out/
bun run start        # Run after build (dev mode)
bun run start:prod   # Build + run isolated prod instance (separate DB, no DevTools)
bun run test         # Driver tests (bun test); some are environment-dependent
bun run dist         # Windows installer via electron-builder
bun run mobile       # Expo dev server for apps/mobile
```

`node apps/desktop/scripts/postinstall.js` runs on `bun install` (root postinstall) — it downloads the Electron binary and the Electron-ABI better-sqlite3 prebuilt. It resolves package dirs via `require.resolve`, so it works with root-hoisted node_modules.

## Desktop Architecture (`apps/desktop`)

PolyCode is an Electron desktop app that provides a UI for orchestrating Claude Code CLI sessions. It has three layers:

**Main Process** (`apps/desktop/src/main/`) — Node.js, runs Claude CLI subprocesses, owns the SQLite DB.
**Renderer Process** (`apps/desktop/src/renderer/src/`) — React + Zustand, all UI.
**Shared types** (`packages/shared/src/types.ts`, re-exported via `apps/desktop/src/shared/types.ts`) — Types used by both processes and the mobile app.

### IPC Communication

The renderer never accesses Node APIs directly. It communicates via `window.api` (defined in `src/preload/index.ts`):

- `window.api.invoke(channel, ...args)` — request/response (wraps `ipcRenderer.invoke`)
- `window.api.on(channel, callback)` — subscribe to events pushed from main
- `window.api.send(channel, ...args)` — fire-and-forget

Main-side handlers live in `src/main/ipc/handlers.ts`. Streaming events are pushed from main to renderer via `webContents.send()` on channels like `thread:output:${threadId}`, `thread:status:${threadId}`, and `thread:complete:${threadId}`.

IPC channel types are documented in `src/renderer/src/types/ipc.ts`.

### Remote Control API (used by the mobile app)

`src/main/remote/server.ts` — plain Node HTTP server (default port 3285, Bearer-token auth):
- `GET /api/remote/health` — connection test (auth required)
- `POST /api/remote/rpc` — `{channel, args[]}` dispatch over the `CONTROL_RPC_CHANNELS` set (`src/main/control/control-rpc.ts`)
- `GET /api/remote/events` — SSE stream of app events (`thread:*`, `command:*`, …) via `src/main/app-events.ts`

The desktop-side remote client (desktop controlling another desktop) is `src/main/remote/client.ts`; the mobile app implements the same protocol.

### Session / Claude Driver

`src/main/session/session.ts` — `Session` owns one `ClaudeDriver` instance per thread. It manages status transitions, persists messages to SQLite, auto-titles threads, and pushes streaming events to the renderer.

`src/main/driver/claude.ts` — `ClaudeDriver` spawns the `claude` CLI with `--output-format stream-json`, parses newline-delimited JSON events, and emits typed events (text, tool_call, tool_result, error, session_id). Uses `--resume <sessionId>` to continue conversations across restarts.

`src/main/session/session.ts` wraps `ClaudeDriver` and is managed by a `SessionManager` singleton.

### Database

SQLite via `better-sqlite3` (synchronous). Schema lives in `src/main/db/index.ts` with additive migrations. Three tables: `projects`, `threads`, `messages`. Queries in `src/main/db/queries.ts`, row types in `src/main/db/models.ts`.

- `threads.claude_session_id` stores the Claude CLI session ID for resumption.
- `threads.status` is reset from `running` → `idle` on startup (crash recovery).
- WAL mode enabled; foreign keys enforced with cascade delete.

### Renderer Stores (Zustand)

| Store | File | Purpose |
|-------|------|---------|
| `useProjectStore` | `stores/projects.ts` | Projects CRUD, active project |
| `useThreadStore` | `stores/threads.ts` | Threads CRUD, status, archived |
| `useMessageStore` | `stores/messages.ts` | Message history, streaming append |
| `useTodoStore` | `stores/todos.ts` | Todos extracted from `TodoWrite` tool calls |
| `useUiStore` | `stores/ui.ts` | UI state (todo panel visibility) |
| `useToastStore` | `stores/toast.ts` | Toast notifications |

### Optimistic UI

Messages are appended immediately with `optimistic-` prefixed IDs. On stream completion, the renderer re-fetches from DB to replace optimistic entries with persisted ones.

## Mobile App (`apps/mobile`)

Expo + expo-router + Zustand. Pure client of the remote-control API: typed RPC wrapper (`src/api/rpc.ts`), SSE manager using `expo/fetch` streaming (`src/api/sse.ts` — global RN fetch does not stream), event router with exact/prefix channel subscriptions (`src/api/events.ts`). Hosts are paired manually or by scanning the QR code in the desktop Remote Control panel (`polycode://pair?...`); tokens live in expo-secure-store.

## Common Pitfalls

### Zustand selector stability
Never use inline fallbacks like `?? []` or `?? {}` in Zustand selectors — they create a new object reference on every render, causing an infinite re-render loop ("getSnapshot should be cached" warning).

Always declare a stable constant outside the component and use that as the fallback:

```ts
// ✗ Bad — new array every render
const todos = useTodoStore((s) => s.todosByThread[threadId] ?? [])

// ✓ Good — stable reference
const EMPTY: Todo[] = []
const todos = useTodoStore((s) => s.todosByThread[threadId] ?? EMPTY)
```

## Running a Production Build

To run a fully isolated production instance (separate DB, no hot-reload, no DevTools):

```
bun run start:prod
```

This builds into `apps/desktop/out/` and launches with `NODE_ENV=production`, which causes the main process to load the renderer from `out/renderer/index.html` instead of the Vite dev server. The prod instance uses a separate userData directory (`%APPDATA%/polycode-electron-prod`) so it won't share state with a simultaneously running dev instance.

The `isDev` guard in `src/main/index.ts` is:
```ts
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'
```
`app.isPackaged` is always `false` when running via `electron .`, so `NODE_ENV` is the only thing distinguishing dev from prod in an unpackaged run.
