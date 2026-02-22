# Polycode

A desktop app for orchestrating multiple AI coding agent sessions (Claude Code, Codex, OpenCode) across projects, with git integration, markdown rendering, and SQLite persistence.

Built with Electron, React, and TypeScript.

## Features

- **Multi-session management** — run multiple agent threads per project simultaneously
- **Multi-provider support** — Claude Code CLI, Codex CLI, and OpenCode CLI
- **Session persistence** — resumes conversations across app restarts
- **Streaming output** — real-time token-by-token rendering with tool call collapsibles
- **Markdown + syntax highlighting** — rendered via `marked` + `highlight.js`
- **Auto-titling** — threads are automatically named based on conversation content
- **Git integration** — tracks modified files per thread
- **Remote execution** — SSH tunnel support for running agents on remote machines
- **Toast notifications** — alerts on completion and errors

## Prerequisites

- [Bun](https://bun.sh/) (package manager and runtime)
- [Node.js](https://nodejs.org/) 18+
- One or more supported CLI agents installed and on your `PATH`:
  - [Claude Code](https://claude.ai/code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - [OpenCode](https://opencode.ai/) (`opencode`)

## Installation

```bash
git clone https://github.com/billpeet/polycode.git
cd polycode
bun install
```

## Usage

```bash
bun run dev          # Start dev server with hot-reload (Vite + Electron)
bun run build        # Production build into out/
bun run start:prod   # Build + run isolated prod instance (separate DB, no DevTools)
```

The production instance stores its database in `%APPDATA%/polycode-electron-prod` (Windows), keeping it separate from any running dev instance.

## Architecture

Polycode has three layers:

| Layer | Location | Description |
|---|---|---|
| Main process | `src/main/` | Node.js — spawns CLI subprocesses, owns SQLite DB, manages sessions |
| Renderer | `src/renderer/src/` | React + Zustand SPA |
| Shared types | `src/shared/types.ts` | Types used across both processes |

The renderer communicates with the main process exclusively via `window.api` (Electron contextBridge). Streaming events are pushed from main to renderer over typed IPC channels.

See [`SPEC.md`](SPEC.md) for the full technical specification including IPC channels, database schema, and roadmap.

## Tech Stack

| | |
|---|---|
| Shell | Electron 33 |
| Build | electron-vite 3 (Vite 6) |
| UI | React 19 + TypeScript 5 |
| Styling | Tailwind CSS v4 |
| Database | better-sqlite3 |
| State | Zustand |
| Markdown | marked + DOMPurify + highlight.js |
| Package manager | Bun |

## License

[MIT](LICENSE)
