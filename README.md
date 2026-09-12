# PolyCode

PolyCode is an Electron desktop app for orchestrating multiple AI coding-agent sessions across projects. It provides a React UI around local or remote CLI agents, with streaming output, SQLite persistence, git tooling, terminals, project commands, todos, plans, and integrations.

## Remote control security

PolyCode's desktop-to-desktop and mobile remote-control protocol uses bearer-authenticated HTTP. HTTP does not encrypt bearer tokens, stored integration credentials, filesystem data, or command results in transit. When a remote host uses an `http://` URL, only run it on a trusted LAN or behind a trusted encrypted tunnel/reverse proxy; use HTTPS for traffic that crosses an untrusted network.

## Web access over Tailscale

A PolyCode desktop can serve its own UI to a browser. The server keeps listening on
`127.0.0.1:3285`; [Tailscale](https://tailscale.com) terminates HTTPS with a `*.ts.net`
certificate, applies your tailnet's access rules, and forwards to it. Nothing is exposed
on the LAN.

1. Install Tailscale on the desktop and sign in. In the Tailscale admin console, enable
   **DNS → HTTPS Certificates** (once per tailnet).
2. In PolyCode, open **Settings → Remote**, enable the host server, and under
   **Tailscale** click **Expose over HTTPS**. PolyCode runs `tailscale serve` for you,
   adds this machine's MagicDNS name to *Allowed hostnames*, and switches *Web access*
   on. The URL shown (`https://<machine>.<tailnet>.ts.net`) works from any device on
   the tailnet.
3. Open it in a browser and paste the host token from the same settings page. The
   browser gets an `HttpOnly` session cookie; the token itself never reaches the page.

Without HTTPS certificates, **Expose without TLS** serves `http://<machine>.<tailnet>.ts.net`
instead — still WireGuard-encrypted on the wire, but the browser has no secure context,
so clipboard access is restricted. Both are equivalent to running
`tailscale serve --bg --https=443 http://127.0.0.1:3285` by hand.

Never enable Tailscale **Funnel** for this port: it would publish PolyCode — and, behind one
token, a shell on this machine — to the public internet. PolyCode refuses to expose while
Funnel is on for the port and warns if it finds it on.

In a browser, desktop-only features are hidden: window controls, opening files in
Explorer/VS Code/a terminal, native file pickers (the browser's own picker is used),
the internal browser panel, and the updater. Everything else — threads, terminals,
git, commands, plans, routines — works as on the desktop.

Built with Electron, React, TypeScript, Vite, Tailwind CSS, Zustand, pnpm, and
Node.js.

## Features

- **Multi-session management** — run and switch between multiple agent threads per project.
- **Multi-provider support** — Claude Code, Codex, OpenCode, Pi, Cursor, and Grok Build.
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
| Cursor | `cursor-agent` | [Cursor CLI](https://cursor.com/cli) |
| Grok Build | `grok` | [Grok Build CLI](https://x.ai/cli) — authenticate with `grok login` or `XAI_API_KEY` |

PolyCode can also check and update these CLIs from the app for local, SSH, and WSL locations.

## Prerequisites

- [pnpm](https://pnpm.io/) 11.x for installing dependencies and running scripts.
- Node.js 22.x is the supported runtime. pnpm automatically downloads and locks
  Node 22.23.1 for project scripts, even if a different Node version is active.
- At least one supported agent CLI installed and authenticated.
- Git, if you want git status/branch/stash/commit features.
- Optional: WSL and/or SSH access for remote execution locations.

### Azure DevOps

Open **Settings > Azure DevOps** and save an Azure DevOps personal access token
with **Code (Read & Write)** permissions. Polycode stores it encrypted using the
operating system and calls the Azure DevOps REST API directly; no Azure CLI is
required. Refresh the pull request panel after saving or replacing the token.
The organization, project, and repository are inferred from the Git remote.
Use a `dev.azure.com` HTTPS or v3 SSH remote, or a `visualstudio.com` HTTPS remote.
For remote Polycode servers, save the token in the server host's desktop settings.
Git fetch/push operations continue to use your existing Git authentication.

## Installation

```bash
git clone https://github.com/billpeet/polycode.git
cd polycode
pnpm install
```

## Usage

```bash
pnpm run dev          # Start Electron + Vite dev server with hot reload
pnpm run build        # Build desktop production assets into apps/desktop/out/
pnpm run preview      # Run electron-vite preview
pnpm run start        # Run Electron from the built main entry
pnpm run start:prod   # Build + run an isolated production-like instance
pnpm run test         # Run Vitest tests for the main process and drivers
pnpm run dist         # Build a Windows NSIS installer
pnpm run dist:publish # Build and publish a Windows release via electron-builder
```

`pnpm run start:prod` sets `NODE_ENV=production` and uses a separate Windows user data directory, `%APPDATA%/polycode-electron-prod`, so it does not share state with a development instance.

## Architecture

PolyCode is a pnpm workspace with desktop and mobile apps plus a shared package:

| Layer | Location | Description |
|---|---|---|
| Desktop main process | `apps/desktop/src/main/` | Node/Electron process that owns SQLite, spawns agent CLIs, runs git/terminal/command operations, manages sessions, and exposes IPC handlers. |
| Desktop preload | `apps/desktop/src/preload/` | Electron `contextBridge` that exposes the safe `window.api` IPC surface to the renderer. |
| Desktop renderer | `apps/desktop/src/renderer/src/` | React + Zustand SPA for projects, threads, messages, terminals, git panels, commands, todos, plans, settings, and integrations. |
| Mobile app | `apps/mobile/` | Expo/React Native client for the remote-control API. |
| Shared package | `packages/shared/` | Dependency-free TypeScript domain types and protocol logic consumed as source by both apps. |

The renderer does not use Node APIs directly. It communicates with the main process through:

```ts
window.api.invoke(channel, ...args) // request/response
window.api.on(channel, callback)    // pushed events, including streaming thread output
window.api.send(channel, ...args)   // fire-and-forget
```

Streaming events are pushed from main to renderer over channels such as `thread:output:{threadId}`, `thread:status:{threadId}`, and `thread:complete:{threadId}`.

## Important source areas

```txt
apps/desktop/src/main/db/                 SQLite schema, migrations, and queries
apps/desktop/src/main/driver/             Agent CLI drivers
apps/desktop/src/main/session/            Thread/session lifecycle management
apps/desktop/src/main/ipc/                Main-process IPC handlers
apps/desktop/src/main/terminal/           Terminal session management
apps/desktop/src/main/commands/           Project command runner management
apps/desktop/src/main/health/             CLI health/update checks
apps/desktop/src/renderer/src/stores/     Zustand stores
apps/desktop/src/renderer/src/components/ React UI components
apps/mobile/                              Expo remote-control client
packages/shared/src/                      Shared domain and protocol code
```

## Data storage

PolyCode stores its SQLite database as `polycode.db` in Electron's `userData` directory. The schema is migration-based and includes projects, repo locations, location pools, threads, sessions, messages, commands, slash commands, settings, YouTrack servers, and related app data.

SQLite runs with WAL mode and foreign keys enabled.

## Observability

The desktop main process can export logs, metrics, and traces using OTLP over
HTTP/protobuf. Export is disabled unless an endpoint is configured:

```powershell
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'https://alloy.example.com/otlp'
$env:OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer token'
$env:OTEL_ENVIRONMENT = 'development'
pnpm dev
```

PolyCode appends `/v1/logs`, `/v1/metrics`, and `/v1/traces` to the configured
base endpoint. Telemetry is batched and flushed during normal shutdown; local
buffered log files remain available when OTLP export is disabled or unreachable.
Do not embed long-lived production credentials in a distributed desktop build.

The initial instrumentation reports renderer and main-process stalls, IPC
latency/call counts, and collected Runner command latency. IPC calls are root
spans and collected Runner commands become children, so slow Git, Forge, driver,
SSH, and WSL work can be attributed without exporting command arguments,
scripts, working directories, repository paths, or remote hostnames.

Explicit user actions also increment `polycode.feature.usage` with a controlled
`feature`, `action`, and `outcome` vocabulary. Polling, reads, status checks, and
automatic refresh channels are excluded from feature usage.

Official GitHub releases package the `https://otlp.biap.cc` endpoint and an
ingestion-only credential supplied by the `POLYCODE_OTLP_HEADERS` Actions
secret. Runtime `OTEL_EXPORTER_OTLP_*` variables take precedence, allowing a
developer or managed installation to redirect or replace the packaged setting.

## Tech stack

| Area | Technology |
|---|---|
| Shell | Electron |
| Build | electron-vite + Vite |
| UI | React + TypeScript |
| Styling | Tailwind CSS v4 |
| State | Zustand 5 |
| Database | better-sqlite3 |
| Terminal | node-pty + xterm.js |
| Markdown/code highlighting | marked + DOMPurify + Shiki |
| Packaging/updating | electron-builder + electron-updater |
| Error reporting | Sentry Electron + Sentry React |
| Observability | OpenTelemetry OTLP logs, metrics, and traces |
| Package manager/runtime | pnpm 11 + Node.js 22 |

## License

[MIT](LICENSE)
