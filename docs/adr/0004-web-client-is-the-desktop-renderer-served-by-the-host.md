# 0004 — The web client is the desktop renderer, served by the Remote Host

Date: 2026-09-12
Status: Accepted

## Context

PolyCode already had two remote clients of a desktop instance: another desktop
(proxying its own renderer's calls) and the Expo mobile app. Both speak the same
bearer-authenticated HTTP API (`POST /api/remote/rpc`, SSE `GET
/api/remote/events`), dispatched through the one typed handler map in
`ipc/channel-handlers.ts`. The ask was a third: a browser, reached over the
owner's tailnet, with the full desktop UI.

Three shapes were considered:

1. **Serve the existing desktop renderer bundle** from the remote-control
   server itself, with an HTTP/SSE implementation of the renderer's client
   interface standing in for the Electron preload.
2. **Export the mobile app for the web.** Rejected: no `web` platform, hard
   dependencies on `expo-secure-store`, `expo-camera` and `expo/fetch`, and a
   phone-shaped UI in a desktop browser.
3. **A new lightweight web UI.** Strictly more work than (1) for less; the
   reduced mobile client already took ~6k lines.

Two properties of the renderer made (1) cheap: its only contact with Electron
was `window.api` (`invoke` / `on` / `send`), whose shape maps 1:1 onto RPC / SSE
/ fire-and-forget RPC; and the server already fanned every app event out to N
SSE subscribers. What it lacked was a seam (346 direct `window.api` call sites)
and any way to serve static files or authenticate a browser.

## Decision

The web client **is** the desktop renderer bundle, served from `/` on the
remote-control port. `lib/client.ts` is the renderer's one seam: in Electron it
resolves to the preload bridge; without one it resolves to `lib/webClient.ts`,
which implements the same interface over the existing API. Renderer code gates
desktop-only surfaces on `client.capabilities`, never on which client it has.

Serving from the same origin as the API means the server's same-origin-only
CORS gate needs no change. A browser authenticates by presenting the host token
once to `POST /api/remote/session` and receiving an `HttpOnly; SameSite=Strict`
cookie; the token never reaches page JavaScript, because `terminal:spawn` is a
remote channel and any XSS would otherwise be a shell on the host.
Cookie-authenticated mutations must also carry a same-origin `Origin`.

The listener stays on loopback. TLS, ACLs and a stable name come from
`tailscale serve`, which the app drives itself (`remote/tailscale.ts`): it
reads the MagicDNS name, adds it to the server's explicit hostname allowlist
(the only relaxation of the DNS-rebinding defence, and only for names the user
chose), and points the tailnet at PolyCode's port. Plain `http://100.x.y.z`
also works, without a secure context.

UI preferences (selected project and thread, layout, sidebar width, favourites)
are per-client — `localStorage` in a browser — so a web client never overwrites
the desktop's own selection.

## Consequences

- One bundle, one set of components, one channel contract. A feature that works
  in the desktop works in the browser unless it is behind a `{ remote: false }`
  channel, in which case a capability flag hides it rather than a runtime
  error surfacing it.
- The browser inherits the registry's remote surface exactly: `settings:*`,
  `shell:*`, `dialog:*`, `window:*`, `update:*`, the internal browser panel and
  (for now) `routines:*` are unavailable. Promoting a group is a registry
  change plus threading any `LocalHandlerContext` dependency into
  `HandlerContext`.
- Sessions are in memory: an app restart signs every browser out. A token
  regeneration does the same, at the same moment it revokes every native
  client.
- The Content-Security-Policy on `index.html` is the second line of defence
  behind DOMPurify and React text nodes, not the first; it allows inline styles
  (Tailwind, xterm, shiki) and WASM (shiki's Oniguruma) and nothing external
  beyond Sentry and PostHog.
- `default_source_dir` is a host path stored browser-side — a known small
  wrongness, accepted over widening `settings:get` to remote callers.
- The Vite dev server proxies `/api` to the running app, so the web path is
  exercised by opening `http://localhost:5173` in a browser during `pnpm dev`.
