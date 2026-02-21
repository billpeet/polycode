# PolyCode — Product Specification

> Desktop app for orchestrating multiple Claude Code (and future CLI agent) sessions across projects, with git integration, markdown rendering, and SQLite persistence.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 33 |
| Build tool | electron-vite 3 (Vite 6) |
| UI framework | React 19 + TypeScript 5 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Database | better-sqlite3 (main process) |
| IPC | Electron contextBridge + ipcMain/ipcRenderer |
| Child processes | Node.js `child_process.spawn` |
| IDs | `uuid` |
| State | Zustand |
| Markdown | marked + DOMPurify + highlight.js |
| Package manager | Bun |

---

## Architecture

```
polycode_electron/
├── src/
│   ├── main/           # Electron main process (Node.js)
│   │   ├── db/         # SQLite via better-sqlite3
│   │   ├── driver/     # CLI process wrappers (ClaudeDriver, …)
│   │   ├── session/    # Session registry + per-thread lifecycle
│   │   └── ipc/        # ipcMain handlers
│   ├── preload/        # contextBridge (window.api)
│   ├── renderer/       # React SPA
│   │   └── src/
│   │       ├── components/
│   │       ├── stores/     # Zustand stores
│   │       └── types/      # IPC type declarations
│   └── shared/         # Types shared across processes
```

---

## IPC Design

### window.api (preload → renderer)
```ts
invoke(channel, ...args): Promise<any>   // request-response
on(channel, callback): () => void        // push events (streaming), returns cleanup
send(channel, ...args): void             // one-way fire-and-forget
```

### Channels

**Invoke:**
- `projects:list` → `Project[]`
- `projects:create(name, path)` → `Project`
- `projects:delete(id)` → `void`
- `threads:list(projectId)` → `Thread[]`
- `threads:create(projectId, name)` → `Thread`
- `threads:delete(id)` → `void`
- `threads:start(threadId, workingDir)` → `void`
- `threads:stop(threadId)` → `void`
- `threads:send(threadId, content)` → `void`
- `messages:list(threadId)` → `Message[]`
- `dialog:open-directory` → `string | null`

**Push events (main → renderer):**
- `thread:output:{threadId}` — `OutputEvent`
- `thread:status:{threadId}` — `ThreadStatus`
- `thread:title:{threadId}` — `string`
- `thread:complete:{threadId}` — (no payload)

---

## Database Schema

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude-code',
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);
```

DB file: `{userData}/polycode.db` (WAL mode, foreign keys on)

---

## Roadmap

### Phase 1 — Scaffold ✅ (complete)
- Electron + React + TypeScript + Tailwind
- SQLite DB layer with migrations
- Claude Code CLI driver skeleton
- Session manager
- IPC handler registration
- Zustand stores
- Component skeleton (Sidebar, ThreadView, MessageStream, InputBar, …)

### Phase 2 — Feature parity with original MVP
- [ ] Full CRUD UI for projects and threads
- [x] Message streaming from Claude Code CLI
- [x] Markdown + syntax highlighting rendering
- [x] Tool call / tool result collapsible blocks
- [x] Auto-scroll with scroll-lock
- [x] Thread auto-title via Claude API
- [ ] Multi-line input with Shift+Enter

### Phase 3 — Polish & UX
- [ ] Diff rendering for code changes
- [x] Thread rename inline UI
- [ ] Keyboard shortcuts
- [x] Loading / streaming indicators (spinner, skeleton)
- [ ] Toast notifications for errors

### Phase 4 — Multi-provider
- [ ] OpenCode CLI driver
- [ ] Codex CLI driver
- [ ] Provider selector per thread

### Phase 5 — Remote execution
- [ ] SSH tunnel management
- [ ] Remote CLI spawning over SSH

### Phase 6 — Advanced
- [ ] Git worktree isolation per thread
- [ ] Thread forking / branching
- [ ] Full-text search over messages
- [ ] Export thread as markdown
- [ ] Auto-update (electron-updater)
- [ ] Cross-platform packaging (macOS .dmg, Linux AppImage, Windows .exe)
