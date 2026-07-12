# PolyCode

PolyCode is an Electron desktop app for orchestrating multiple AI coding-agent sessions across projects. It provides a React UI around local or remote CLI agents, with streaming output, SQLite persistence, git tooling, terminals, project commands, todos, plans, and integrations.

## Remote control security

PolyCode's desktop-to-desktop and mobile remote-control protocol uses bearer-authenticated HTTP. HTTP does not encrypt bearer tokens, stored integration credentials, filesystem data, or command results in transit. When a remote host uses an `http://` URL, only run it on a trusted LAN or behind a trusted encrypted tunnel/reverse proxy; use HTTPS for traffic that crosses an untrusted network.

Built with Electron, React, TypeScript, Vite, Tailwind CSS, Zustand, and Bun.

## Features

- **Multi-session management** — run and switch between multiple agent threads per project.
- **Multi-provider support** — Claude Code, Codex, OpenCode, and Pi.
- **Provider/model selection** — choose supported models per thread and preserve recent choices.
- **Session persistence** — stores projects, threads, sessions, messages, token usage, and settings in SQLite.
- **Streaming output** — real-time assistant output with structured tool-call, thinking, question, and permission blocks.
- **Markdown rendering** — sanitized markdown with syntax highlighting.
- **Plans and todos** — plan panes and TodoWrite-derived todo tracking.
- **Git integration** — status, branches, pull, stash, commit log, changed-file tracking, and hosting-provider helpers.
- **Project locations** — local, SSH, and WSL repo locations, including location pools.
- **Integrated terminals and commands** — per-project command runners, logs, ports, and xterm-based terminals.
- **Slash commands and attachments** — reusable prompts plus supported message attachments.
- **CLI health checks and updates** — checks installed agent CLIs locally, over SSH, or in WSL.
- **Integrations** — YouTrack UI support plus main-process GitHub/Azure DevOps helpers.
- **Notifications and logging** — toast notifications, thread logs, command logs, and Sentry integration.
- **Auto-update packaging** — Windows NSIS installer and GitHub release publishing via `electron-builder`.

## Supported agent CLIs

Install one or more of these and make sure they are available on your `PATH` in the environment where PolyCode runs:

| Provider | CLI command | Package / project |
|---|---:|---|
| Claude Code | `claude` | [`@anthropic-ai/claude-code`](https://claude.ai/code) |
| Codex | `codex` | [`@openai/codex`](https://github.com/openai/codex) |
| OpenCode | `opencode` | [`opencode-ai`](https://opencode.ai/) |
| Pi | `pi` | [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) |

PolyCode can also check and update these CLIs from the app for local, SSH, and WSL locations.

## Prerequisites

- [pnpm](https://pnpm.io/) 11.x for installing dependencies and running scripts.
- Node.js 22.x is the supported runtime. pnpm automatically downloads and locks
  Node 22.23.1 for project scripts, even if a different Node version is active.
- At least one supported agent CLI installed and authenticated.
- Git, if you want git status/branch/stash/commit features.
- Optional: WSL and/or SSH access for remote execution locations.

## Installation

```bash
git clone https://github.com/billpeet/polycode.git
cd polycode
pnpm install
```

## Usage

```bash
pnpm run dev          # Start Electron + Vite dev server with hot reload
pnpm run build        # Build production assets into out/
pnpm run preview      # Run electron-vite preview
pnpm run start        # Run Electron from the built main entry
pnpm run start:prod   # Build + run an isolated production-like instance
pnpm run test         # Run Vitest tests for the main process and drivers
pnpm run dist         # Build a Windows NSIS installer
pnpm run dist:publish # Build and publish a Windows release via electron-builder
```

`pnpm run start:prod` sets `NODE_ENV=production` and uses a separate Windows user data directory, `%APPDATA%/polycode-electron-prod`, so it does not share state with a development instance.

## Architecture

PolyCode has three main layers:

| Layer | Location | Description |
|---|---|---|
| Main process | `src/main/` | Node/Electron process that owns SQLite, spawns agent CLIs, runs git/terminal/command operations, manages sessions, and exposes IPC handlers. |
| Preload | `src/preload/` | Electron `contextBridge` that exposes the safe `window.api` IPC surface to the renderer. |
| Renderer | `src/renderer/src/` | React + Zustand SPA for projects, threads, messages, terminals, git panels, commands, todos, plans, settings, and integrations. |
| Shared types | `src/shared/types.ts` | TypeScript types, providers, model catalogs, thread/message/session shapes, and shared IPC payload types. |

The renderer does not use Node APIs directly. It communicates with the main process through:

```ts
window.api.invoke(channel, ...args) // request/response
window.api.on(channel, callback)    // pushed events, including streaming thread output
window.api.send(channel, ...args)   // fire-and-forget
```

Streaming events are pushed from main to renderer over channels such as `thread:output:{threadId}`, `thread:status:{threadId}`, and `thread:complete:{threadId}`.

## Important source areas

```txt
src/main/db/              SQLite schema, migrations, and queries
src/main/driver/          Agent CLI drivers: Claude, Codex, OpenCode, Pi
src/main/session/         Thread/session lifecycle management
src/main/ipc/             Main-process IPC handlers
src/main/terminal/        Terminal session management
src/main/commands/        Project command runner management
src/main/health/          CLI health/update checks
src/renderer/src/stores/  Zustand stores
src/renderer/src/components/ React UI components
src/shared/types.ts       Shared models, providers, and event types
```

## Data storage

PolyCode stores its SQLite database as `polycode.db` in Electron's `userData` directory. The schema is migration-based and includes projects, repo locations, location pools, threads, sessions, messages, commands, slash commands, settings, YouTrack servers, and related app data.

SQLite runs with WAL mode and foreign keys enabled.

## Tech stack

| Area | Technology |
|---|---|
| Shell | Electron 33 |
| Build | electron-vite 5 + Vite 8 |
| UI | React 19 + TypeScript 5 |
| Styling | Tailwind CSS v4 |
| State | Zustand 5 |
| Database | better-sqlite3 |
| Terminal | node-pty + xterm.js |
| Markdown/code highlighting | marked + DOMPurify + Shiki |
| Packaging/updating | electron-builder + electron-updater |
| Error reporting | Sentry Electron + Sentry React |
| Package manager/runtime | Bun |

## License

[MIT](LICENSE)
