# Plan: Web client for a Remote Host

Serve the desktop renderer from the remote-control server so a browser on the
tailnet can drive a PolyCode host with the full desktop UI.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Client | The existing desktop renderer bundle, served from `/` on the remote-control port (3285) | Full fidelity; one bundle for Electron and browser; same origin, so the same-origin-only CORS gate stays untouched |
| Transport | Existing `POST /api/remote/rpc` + SSE `GET /api/remote/events` | Already serves mobile and desktop-to-desktop; `packages/shared/src/event-stream.ts` runs on browser `fetch` unchanged |
| Audience | The owner's own PCs over a tailnet | Tailscale ACLs are the outer wall; PolyCode still authenticates every API call |
| Network | PolyCode keeps its `127.0.0.1` bind; `tailscale serve` terminates HTTPS | Nothing exposed on LAN; browser gets a secure context (`*.ts.net` cert); identity headers available later |
| Browser auth | Paste the host token once → `HttpOnly; SameSite=Strict` session cookie | Token never sits in JS-reachable storage; native clients keep using Bearer |
| UI preferences | Browser-local (`localStorage`), never written to the host | Web clients must not clobber the host's selected project/thread, sidebar width, etc. |
| Electron-only features | Hidden behind a `capabilities` object derived from the client kind | One place decides; no per-call-site `if (isWeb)` |

Record the first row as ADR 0004 once Phase 3 lands.

## What the browser cannot do (by design)

Everything the registry marks `{ remote: false }` (33 channels): window
controls, `shell:*`, native `dialog:*`, main-process clipboard, the internal
`<webview>` browser panel, updater, webhook config, remote-host management, and
`settings:*`. `routines:*` is the one group with no technical reason to stay
local — see Phase 5.

## Phase 0 — Spike (1 day, throwaway branch)

Goal: see the renderer boot in a browser and enumerate what breaks.

1. In `remote/server.ts`, serve `out/renderer` for `GET /` and `/assets/*`.
2. Temporarily accept `?token=` on the SSE and RPC paths.
3. Add the MagicDNS name to a hard-coded allowlist in `isAllowedHostHeader`.
4. Stub `window.api` in the browser console with a 30-line HTTP shim.

Record the list of runtime failures; it seeds the Phase 3 gating list below.
Verify specifically: the CSP that xterm, shiki, and tiptap tolerate; whether
`@sentry/electron/renderer` throws on import without a preload.

## Phase 1 — Client seam (Electron-only, no behaviour change)

Ships alone. After this PR the desktop app behaves identically.

### `apps/desktop/src/renderer/src/lib/client.ts`

```ts
export interface ClientCapabilities {
  windowControls: boolean   // TitleBar min/max/close, drag region
  shell: boolean            // shell:*, app:open-logs-folder
  nativeDialogs: boolean    // dialog:open-directory / open-files / open-favicon
  browserPanel: boolean     // browser:* and <webview>
  updates: boolean          // update:*
  remoteHosts: boolean      // remote:* panel and host switcher
  routines: boolean         // routines:* (false on web until Phase 5)
}
export interface Client extends WindowApi {
  kind: 'electron' | 'web'
  capabilities: ClientCapabilities
}
export const client: Client = window.api
  ? electronClient(window.api)   // all capabilities true
  : createHttpClient()           // Phase 3
```

Codemod: `window.api.` → `client.` across the renderer (309 `invoke`, 29 `on`,
6 `send`, 1 `onSlowInvoke`, 1 `systemLocale`; 63 files). Delete the
`declare global { interface Window { api: WindowApi } }` in `types/ipc.ts` and
make `window.api` optional so the web path type-checks.

### `apps/desktop/src/renderer/src/lib/prefs.ts`

`getPref(key)` / `setPref(key, value)` wrapping the eight UI keys the renderer
stores today: `selectedProjectId`, `selectedThreadId` (`App.tsx`),
`sidebar:viewMode`, `sidebar:width`, `layout:mode` (`stores/ui.ts`),
`projects:sortMode`, `favourites:combos`, `default_source_dir`
(`NewProjectForm`, `LocationFormSection`). Electron backend: `settings:*` IPC
(unchanged). Web backend: `localStorage` keyed by `polycode:<key>`.

`default_source_dir` is a host path, so browser-local is slightly wrong for it;
accept that rather than promote `settings:get` (which would expose every key,
including tokens). Revisit with a key-allowlisted `prefs:*` channel if it bites.

### `apps/desktop/src/renderer/src/lib/locale.ts`

`client.systemLocale ?? navigator.language`.

### Tests

- `lib/__tests__/client.test.ts`: `electronClient` forwards every member; capabilities all true.
- `lib/__tests__/prefs.test.ts`: both backends.
- Extend `main/__tests__/preload-allowlist.test.ts` companion: a renderer test that
  greps `src/renderer/src` for `window.api` and fails on any hit outside `client.ts`.

## Phase 2 — Server

### Config: `packages/shared/src/types.ts` `RemoteServerConfig`

```ts
webEnabled: boolean          // serve the UI at all (default false)
allowedHostnames: string[]   // e.g. ['pc.tailnet.ts.net']
```

Persist in `remote/config.ts` as `remote:server:web` and
`remote:server:allowedHostnames`. Surface both in `RemoteControlPanel.tsx`.

### `main/http-request-security.ts`

- `isAllowedHostHeader(hostHeader, bindHost, port, allowedHostnames, localHostname)`:
  a hostname in `allowedHostnames` passes regardless of port (behind Serve the
  browser sends `Host: pc.tailnet.ts.net`, no port). Existing branches unchanged
  so the DNS-rebinding defence is only relaxed for names the user typed.
- `getAllowedCorsOrigin(origin, host, forwardedProto)`: accept `https:` when
  `X-Forwarded-Proto: https`. Without this the same-origin check fails behind
  Serve because the browser's origin is `https://…`.

### `main/remote/sessions.ts` (new)

In-memory `Set<string>` of 32-byte random session ids. `mint()`, `has()`,
`revoke()`, `clear()` (called from `regenerateServerToken` and server restart).

### `main/remote/server.ts`

New routes, in order, before the existing ones:

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| `GET` | `/`, `/index.html`, `/assets/*` | none | static from `out/renderer`; 404 unless `webEnabled` |
| `POST` | `/api/remote/session` | body `{ token }` | timing-safe compare → `Set-Cookie: polycode_session=…; HttpOnly; SameSite=Strict; Path=/` plus `Secure` when `X-Forwarded-Proto: https`; 401 otherwise; 429 after 5 failures/min per `X-Forwarded-For`/socket IP |
| `DELETE` | `/api/remote/session` | cookie | revoke |

`isAuthorized()` accepts Bearer **or** a valid session cookie. Cookie-authenticated
`POST`s must also carry an `Origin` that `getAllowedCorsOrigin` accepts (CSRF
belt to go with the `SameSite=Strict` braces). Bearer clients are unaffected.

`GET /api/remote/health` becomes reachable with either credential; the web
client uses it as its "am I logged in?" probe and for the version string.

### `main/remote/static.ts` (new)

Resolve against `join(__dirname, '../renderer')`, reject anything that escapes
it, small content-type map, `Cache-Control: public, max-age=31536000, immutable`
for hashed `/assets/*`, `no-store` for `index.html`. Response headers on
`index.html`:

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;
  connect-src 'self' <sentry-ingest> <posthog-host>; font-src 'self' data:;
  frame-src 'none'; object-src 'none'; base-uri 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Tighten after Phase 0 tells us what actually needs `'unsafe-inline'`.

### SSE allowlist

Add `routines:changed` to `shouldStreamEvent` (needed by Phase 5; harmless now).

### Tests

- `http-request-security.test.ts`: allowlisted hostname without port; non-allowlisted DNS name still 421; `https:` origin accepted only with forwarded proto.
- `http-auth.test.ts` + new `remote-sessions.test.ts`: mint/verify/revoke; regenerate-token clears sessions; rate limit.
- New `remote-static.test.ts`: traversal (`/assets/../main/index.js`) → 404; content types; cache headers; 404 when `webEnabled=false`.
- New `remote-server-routes.test.ts` against `http.createServer(createRequestHandler(...))` on an ephemeral port: cookie auth on `/rpc`, CSRF rejection without Origin, Bearer path unchanged.

## Phase 3 — Web client

### `renderer/src/lib/httpClient.ts`

Implements `Client` with `kind: 'web'`:

- `invoke(channel, ...args)`: reject unless `isRemoteChannel(channel)` (mirror of
  the preload allowlist — the server would refuse anyway, but failing locally
  keeps the error legible). `fetch('/api/remote/rpc', { method: 'POST',
  credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } })`.
  `{ ok: false }` → throw `Error(error)`. 401 → flip the login gate.
- `on(channel, cb)`: one `RemoteEventStream` (from `@polycode/shared`) with
  `fetch: window.fetch`, target `{ baseUrl: location.origin, token: '' }` — the
  stream's `Authorization` header is empty and the cookie carries auth. Demux by
  exact channel name into a `Map<string, Set<cb>>`.
- Connection state: map the stream's `onConnected` / `onDisconnected` /
  `onStreamError` onto `RemoteConnectionState` (`hostId: 'web'`, phases
  `connected` / `reconnecting` / `unavailable`) and deliver it to
  `remote:connection-changed` subscribers. `remote:getConnectionState` and
  `remote:reconnect` are answered locally. The existing
  `RemoteConnectionBanner` and `reconnectNonce` refetch logic then work unchanged.
- `send(channel, ...args)`: `terminal:write` / `terminal:resize` → fire-and-forget
  `invoke`; `log:write` / `telemetry:*` → dropped.
- `onSlowInvoke`: lift `trackSlowInvoke` out of `preload/index.ts` into
  `packages/shared` (or duplicate the 20 lines) so both clients report it.
- `systemLocale`: `navigator.language`.
- `capabilities`: everything `false` except what Phase 5 turns on.

### `renderer/src/components/WebLogin.tsx`

Rendered by `main.tsx` when `client.kind === 'web'` and `GET /api/remote/health`
returns 401. One password field, `POST /api/remote/session`, then mount `<App />`.
Also shown on any later 401 from `invoke`.

### `renderer/src/main.tsx`

- Sentry: `client.kind === 'electron'` → `@sentry/electron/renderer`, else
  `@sentry/react` (already a dependency). Use dynamic `import()` so neither
  package initialises in the wrong host.
- Skip `installRendererLogForwarding` on web (console only).

### Gating (one `capabilities` check each)

| File | Gate | Web behaviour |
|---|---|---|
| `TitleBar.tsx` | `windowControls`, `remoteHosts` | plain title, no drag region, no host switcher |
| `Browser.tsx`, `stores/browser.ts`, `App.tsx:80` | `browserPanel` | tab hidden; `browser:popup-request` never subscribed |
| `ThreadHeader.tsx:359–406`, `GitSection.tsx:1111–1127` | `shell` | actions hidden |
| `InputBar.tsx:608, 688` | `nativeDialogs` | `<input type="file">` → `attachments:save` (data URL, `remote: true`, 15 MiB cap); previews via `attachments:readDataUrl` (already `remote: true`) |
| `NewProjectForm`, `LocationFormSection`, `LocationDialog`, `ProjectDialog` | `nativeDialogs` | Browse buttons hidden; path text inputs remain |
| `UpdateBanner`, `UpdateReleaseNotesDialog` | `updates` | not rendered |
| `SettingsDialog` (logs folder, `RemoteControlPanel`, `WebhookPanel`) | `shell`, `remoteHosts` | sections hidden |
| `RoutinesSection`, `RoutineEditModal` | `routines` | hidden until Phase 5 |
| `ExpandedSidebar.tsx:137` (`app:getVersion`) | — | version from `/health` |
| `lib/clipboard.ts` | `shell` | skip the main-process fallback |
| `lib/markdownFileLinks.ts` `file:///` | `shell` | render as plain text |

### Dev loop

`electron-vite dev` already serves the renderer on `:5173`. Add to
`electron.vite.config.ts` renderer `server.proxy`:
`{ '/api': { target: 'http://127.0.0.1:3285', changeOrigin: true } }`.
Opening `http://localhost:5173` in a browser hits the web path (no preload, so
`window.api` is undefined) against the running dev app's server. `changeOrigin`
rewrites `Host` to `127.0.0.1:3285`, which passes the existing gate.

### Tests

- `lib/__tests__/httpClient.test.ts` with a stubbed `fetch`: allowlist rejection;
  request encoding; `{ ok: false }` → throw; `on` demux and unsubscribe;
  connection-state transitions reach `remote:connection-changed`; `send` mapping.
- `components/__tests__/WebLogin.test.tsx` (happy-dom): 401 → form → success mounts app.
- Renderer capability tests for `TitleBar` and `InputBar` under `kind: 'web'`.

## Phase 4 — Hardening, Tailscale, docs

- Threat review of the `remote: true` set as reachable from a browser: it
  includes `terminal:spawn`, `commands:*`, git push, file reads. Any XSS in
  markdown/tool-output rendering becomes host RCE, which is why CSP and
  `HttpOnly` are not optional. Confirm every user/provider-controlled string
  passes through DOMPurify or React text nodes.
- Optional: "Trust Tailscale identity" setting. When the bind host is loopback
  and `Tailscale-User-Login` is present, skip the token step. Spoofable only by
  local processes, which can already read the SQLite token. Off by default.
- README: `tailscale serve --bg --https=443 http://127.0.0.1:3285`, add the
  MagicDNS name under *Allowed hostnames*, turn on *Web access*. Note that the
  direct `http://100.x.y.z:3285` path also works (bind to the tailnet IP) but
  without a secure context.
- Update the README's transport-security paragraph and the `Channel` glossary
  entry in `CONTEXT.md` (a Web Client is a third kind of PolyCode client).
- ADR 0004.

## Phase 5 — Promote `routines:*` to remote (optional)

The registry comment says "desktop-only in v1", a scoping choice. Blocker to
verify: `routines:runNow` / `dismissRun` / `runHasUnshippedWork` read
`ctx.runLifecycle` from `LocalHandlerContext`. Promotion means moving
`runLifecycle` into `HandlerContext`, threading it from `main/index.ts` through
`startRemoteControlServer` → `handleControlRpc`, flipping nine registry entries,
and extending `control-rpc-contract.test.ts`. Mobile gets routines for free.

## Estimate

| Phase | Effort |
|---|---|
| 0 Spike | 1 day |
| 1 Seam | 1–2 days (codemod + tests) |
| 2 Server | 2–3 days |
| 3 Web client | 3–4 days |
| 4 Hardening + docs | 2–3 days |
| 5 Routines | 1 day |

Phases 1 and 2 are independent and can be parallel PRs; 3 depends on both.

## Open risks

- Vite output uses `./assets/…` relative URLs; serving from `/` works, but the
  spike must confirm nothing resolves `import.meta.url` against `file://`.
- `RemoteEventStream` has no replay. Already handled by `reconnectNonce`; the
  web client inherits the same "refetch on recovery" behaviour, not new work.
- Cookie sessions are in-memory: an app restart logs every browser out. Acceptable.
- Multiple concurrent web clients are fine (SSE fan-out is already N-subscriber),
  but two clients editing the same thread simultaneously is the same untested
  situation mobile + desktop are in today.
