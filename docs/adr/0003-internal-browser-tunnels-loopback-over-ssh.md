# 0003 — The internal browser tunnels loopback over the location's SSH connection

Date: 2026-08-18
Status: Accepted

## Context

PolyCode conducts Threads at Project Locations, which may be SSH connections to
remote hosts. When the user runs a dev server there (`npm run dev` →
`http://localhost:5173`), they need to see it. An internal browser panel must
show `localhost:5173` **as the session host sees it** — not as this machine
sees it. Rewriting navigated URLs was rejected at the outset: a page's own
subresource requests, fetches and HMR WebSockets go straight to the literal
host, and a URL-rewriting layer would have to intercept all of them inside the
page's own origin, breaking host checks, cookies and dev-server CORS in the
process.

Two decisions needed making: how to embed live web content, and how to get its
loopback traffic to the remote host.

Embedding options:

1. **`WebContentsView` in the main process.** Fast, but it paints above the
   whole renderer — the panel system, toasts, dialogs and popovers would all
   need bounds synchronisation and z-order choreography around it.
2. **The `<webview>` tag.** A DOM element: it sits in the SecondPanel's
   existing tab/resize layout for free, and each instance can carry its own
   `partition`, which maps naturally onto per-location sessions.

Transport options for the loopback hop:

1. **Bind the real local port and forward it.** `ssh -L 127.0.0.1:5173:...`
   would clash with any dev server the user runs locally on the same port, and
   PolyCode cannot know which ports are taken.
2. **A local HTTP proxy, reached through Chromium's proxy configuration.**
   Chromium already supports routing an embedder's session through a proxy;
   the proxy can relay loopback targets through an `ssh -L` tunnel and
   everything else directly. The page keeps its URL, Host header, origin and
   cookies; only the transport changes.

## Decision

The internal browser is a `<webview>` panel in the SecondPanel, one tab per
page, with one persisted Electron session per Project Location
(`persist:browser:{locationId}`) so dev-server logins survive restarts and stay
isolated per location.

For SSH-backed locations, that session is put in `fixed_servers` proxy mode
pointing at a loopback-only HTTP proxy owned by the main process, with the
`<-loopback>` bypass rule — **this negation is the load-bearing detail**:
Chromium implicitly bypasses proxies for loopback hosts, so without
`<-loopback>` every `localhost:*` request would silently skip the tunnel and
hit the local machine. The proxy relays loopback requests through `ssh -N -L`
local forwards spawned on demand per (host, port) — the same `ssh` invocation
(`buildSshBaseArgs`) as every other remote operation, so ControlMaster
multiplexing and host-key policy match the Runner. Non-loopback traffic also
transits the proxy and is relayed direct; HTTPS travels as tunneled TCP
(CONNECT), so TLS stays end-to-end.

Local and WSL locations configure the session `direct`. WSL dev servers are
reachable because WSL2 forwards localhost itself; no PolyCode-side transport
exists for WSL.

The browser channels are desktop-only (`remote: false` in CHANNEL_REGISTRY): a
Remote Host renders no UI, and the guest sessions and tunnel pools live in the
desktop app's main process.

## Consequences

- The page sees itself as `http://localhost:5173` in every respect that
  matters — Host header, origin, redirects, HMR WebSockets, host checks. No
  URL rewriting exists anywhere in the feature.
- Closing the panel releases the session, which tears down the proxy and its
  ssh processes after a short grace period; persisted partitions keep cookies
  and localStorage across that boundary. Switching tabs within the panel or
  between SecondPanel tabs keeps guest processes alive (height-0 mounting, the
  same trick the terminal uses for its PTY); navigating away from the location
  unmounts guests, so page state resets while logins persist.
- Guest popups (`target=_blank`) are denied as windows and routed back to the
  renderer as "open a new tab in the same location's panel" requests, keyed by
  the guest's session. Guest permission requests (camera, notifications, …)
  are denied without prompting.
- Each (host, port) pair costs one `ssh` process for as long as it is in use;
  idle tunnels are reaped after ten minutes with no open sockets. Non-loopback
  browsing takes a Node relay hop instead of Chromium's own stack — accepted
  for a development tool.
- WSL locations depend on WSL2's localhost forwarding being enabled (the
  default). If a user disables it, the browser cannot be blamed for the
  resulting ECONNREFUSED.
