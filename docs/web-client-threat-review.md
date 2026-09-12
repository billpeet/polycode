# Web client threat review

Date: 2026-09-12. Scope: the surface a browser session reaches once the desktop
serves its UI (ADR 0004). Companion to `docs/web-client-plan.md` Phase 4.

## Model

A web session holder can do everything the desktop can over `remote: true`
channels — including `terminal:spawn`. That is the product. The question this
review asks is: **can someone who is not the session holder get the session to
act?** Three routes:

1. Content rendered in the page — provider output, repository files, forge
   data, process output — achieving script execution or navigation.
2. Cross-site requests riding the session cookie.
3. Input-validation gaps that turn an authorised call into more than it should be.

## Findings and dispositions

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | `attachments:save` / `attachments:cleanup` joined a client-supplied `threadId` into a path under the attachment dir; `cleanup` is a recursive delete. A traversing id deleted an arbitrary tree or dropped a file of chosen extension and content anywhere writable. | High | Fixed: `resolveThreadDir` enforces id shape and containment (`main/attachments.ts`). |
| 2 | `will-navigate` and `setWindowOpenHandler` passed any URL to `shell.openExternal`; only the `shell:openExternal` channel had a scheme guard. React blocks `javascript:` only, so `file:`/`ms-msdt:`/`vscode:` reached the OS handler. Inputs were narrow (DOMPurify-filtered hrefs, forge-supplied `pr.url`), but the chokepoint had the wrong default. | Medium | Fixed: one `isOpenableExternalUrl` (`http`, `https`, `mailto`) for all three sites; PR anchors open in a new tab with `noreferrer`. |
| 3 | Sessions had no server-side lifetime; a leaked cookie stayed valid until app restart or token change. | Medium | Fixed: 30-day absolute and 7-day idle limits, enforced on every use. |
| 4 | `ADD_ATTR: ['style']` on provider markdown let a message paint `position:fixed` overlays over the real UI (fake permission prompts, hidden buttons). `formaction` on the re-admitted `<button>` bypassed DOMPurify's URI filter (inert only because `<form>` was not allowed). Two call sites ran different policies over the same content class. | Medium | Fixed: `lib/sanitizeMarkdown.ts` — `style` kept only on `<span>` for token text properties; `<form>`/`formaction` forbidden; both sites share it; regression suite under happy-dom. |
| 5 | `tailscale funnel` on the served port would publish the login endpoint (token + rate limit) to the internet; nothing noticed. | Medium (latent) | Fixed: `AllowFunnel` parsed; the panel warns, *Expose* refuses while on; README says never. |
| 6 | The login rate limiter keyed on `X-Forwarded-For` from any peer, so a direct client could be as many addresses as it liked. | Low | Fixed: the header is honoured only when the peer is loopback (a local proxy such as `tailscale serve`). |
| 7 | PostHog autocapture and Sentry tracing ran on the browser page, reporting the tailnet hostname and clicked-element text off-tailnet. | Low (privacy) | Fixed: no PostHog in a browser; Sentry errors only, no tracing. |
| 8 | CSP `img-src https:` lets provider markdown make the viewer fetch an external image — a read receipt. | Info | Accepted: dropping it breaks README images from forges. |

## Confirmed sound

- No raw-HTML sink without DOMPurify: zero `dangerouslySetInnerHTML`; the two
  `innerHTML` writes are sanitised. `marked` passes raw HTML through; DOMPurify's
  default URI filter rejects `javascript:`, `data:`, `file:` and every unlisted
  scheme on `href`/`src`, and strips `on*`.
- CSP as second wall (`main/remote/static.ts`): `script-src 'self'
  'wasm-unsafe-eval'` — no inline script, no `javascript:` navigation, no
  handler attributes execute even if the sanitiser slipped. `frame-ancestors
  'none'`, `object-src 'none'`, `base-uri 'none'`. `style-src 'unsafe-inline'`
  must stay (React inline styles), which is why finding 4 is handled in the
  sanitiser rather than the CSP.
- Cookie and CSRF: `HttpOnly; SameSite=Strict` (+`Secure` behind TLS); a
  same-origin `Origin` is required on cookie-authenticated mutations; CORS is
  same-origin only; the renderer never reads `document.cookie`; login bodies
  are capped at 4 KiB; ids are 32 random bytes; a token change revokes all.
- Terminal output: xterm renders to cells, never HTML. The hand-rolled link
  regex is `https?://` only; browser-mode activation is `window.open(...,
  'noopener')`; OSC 8 hyperlinks are `http(s)`-only by xterm default, behind a
  confirm.
- Diff and code rendering: `@pierre/diffs` and shiki escape via hast
  serialisation inside a shadow root; the file-preview code path renders
  tokens as React text.
- Images: every data-driven `<img>` is a `data:` URL, so a hostile SVG is inert
  (image mode: no script, no fetches).
- Tiptap: only user drafts reach the `html: true` composer; the editor that
  receives AI-generated PR text is `html: false`.

## Tailnet identity sign-in (added after the review)

A browser may be signed in by the `Tailscale-User-Login` header instead of the
token. The header is trusted only when all of the following hold, checked in
`remote/identity.ts`: web access is on; the login is on the user's allowlist
(default: this node's owner — reaching the port under the tailnet's ACLs is not
the same as being let in); the socket peer is loopback (`tailscaled` proxies
from this machine, so any other peer typed the header itself); and the request
is not a Funnel request. A match does one thing: mint the ordinary session
cookie, on `GET /api/remote/health` only. Every other request, including every
mutation, authenticates exactly as before, so the CSRF analysis above is
unchanged. A local process could forge the header, and could already read the
token from SQLite — nothing new is granted.

## Residual

- The session holder is trusted completely. There is no per-channel policy for
  a browser beyond the registry's `remote` flag; that is by design for an
  owner-only tailnet and would need revisiting before any multi-user story.
- Sessions are in memory; a desktop restart signs every browser out. Accepted.
- `img-src https:` (finding 8).
