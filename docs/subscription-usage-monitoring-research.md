# Subscription usage-limit monitoring research

Research date: 2026-09-05

## Recommendation

Build a main-process `SubscriptionUsageService` with one adapter per provider and a single normalized snapshot model. For OpenAI, use the **official Codex app-server JSON-RPC interface** (`account/rateLimits/read`) rather than calling ChatGPT's private HTTP endpoint directly. For Anthropic, use Claude Code's **official status-line JSON feed**, which now includes five-hour and seven-day quota state. Use its read-only OAuth usage endpoint only as an explicitly labelled fallback, cache heavily, and never refresh or rewrite Claude Code's credentials. Add GLM later; its quota endpoint is comparatively simple but is also undocumented.

This gives PolyCode first-party local boundaries for both important providers. Anthropic's status-line feed is event-driven rather than independently queryable, so its snapshots need a visible age/staleness indicator.

## Evidence and options

### OpenAI Codex subscription

The strongest integration surface is shipped by the open-source Codex CLI itself. Its app-server documents `account/rateLimits/read`, returning normalized `primary` and optional `secondary` windows with `usedPercent`, `windowDurationMins`, and Unix `resetsAt`. It also emits sparse `account/rateLimits/updated` notifications. Codex owns ChatGPT OAuth login, persistence, and token refresh in this mode. See the [official Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints).

Example request after the documented app-server initialization handshake:

```json
{ "method": "account/rateLimits/read", "id": 7 }
```

Relevant result shape:

```json
{
  "rateLimits": {
    "primary": { "usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1730947200 },
    "secondary": { "usedPercent": 8, "windowDurationMins": 10080, "resetsAt": 1731379200 },
    "rateLimitReachedType": null
  },
  "rateLimitResetCredits": { "availableCount": 0, "credits": [] }
}
```

Do not assign semantic names merely by array position: classify a window from `windowDurationMins` (300 = 5 hours, 10080 = 7 days), retain unknown durations, and tolerate either window being absent. Recent official issue evidence shows that returned windows can occasionally be incomplete or inconsistent with request rejection state, so surface `observedAt`, source, and stale/error state rather than presenting the value as infallible ([OpenAI issue #38603](https://github.com/openai/codex/issues/38603)).

The lower-level implementation used by Codex is currently `GET https://chatgpt.com/backend-api/wham/usage`, authenticated with the ChatGPT OAuth bearer token and `ChatGPT-Account-Id`. Its observed response contains `plan_type`, `rate_limit.primary_window`, `secondary_window`, and optional additional limits/credits. The endpoint and schema are covered by community implementations such as [codex-session's tested specification](https://github.com/gubasso/codex-session/blob/develop/docs/wham-usage-api-spec.md), and an official Codex issue confirms the CLI polls it approximately every 60 seconds ([openai/codex #10869](https://github.com/openai/codex/issues/10869)). However, it is undocumented and has changed shape. It should be a fallback only, not PolyCode's primary contract.

Practical invocation: run one long-lived `codex ... app-server` child per execution location (local/WSL/SSH), complete the documented initialization handshake, request `account/rateLimits/read`, listen for update notifications, and restart with backoff if the process exits. This naturally reuses the login associated with the CLI in that location and avoids copying credentials across machine boundaries.

### Anthropic Claude subscription

Anthropic officially documents that Claude and Claude Code share subscription limits and that the short window resets every five hours ([Anthropic Help Center](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-max-plan)). More importantly, current Claude Code officially exposes machine-readable quota values to custom status-line commands ([Claude Code status-line documentation](https://code.claude.com/docs/en/statusline#available-data)):

```json
{
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
}
```

`rate_limits` is present for Claude.ai Pro/Max subscribers only after the first API response; each window may independently be absent and is dropped when its reset time passes. Claude invokes the configured status-line command at session start, after assistant responses and other events, and at reset time. The command receives JSON on stdin and does not consume API tokens.

The best PolyCode integration is therefore an opt-in helper command that atomically caches only the `rate_limits` subset where the PolyCode main process can read it. The helper can print an empty string (or a compact quota line if the user wants it displayed in Claude itself). This avoids OAuth token access and private network calls entirely. Installation must preserve user control because Claude Code supports one `statusLine.command`: offer a documented wrapper/chaining option and never silently replace an existing command. Treat snapshots as stale when no Claude session has produced an update recently. A current user report shows the documented field can still be missing for some Pro/macOS configurations, so absence must not be displayed as 0% ([anthropics/claude-code #86169](https://github.com/anthropics/claude-code/issues/86169)).

#### Undocumented OAuth fallback

For users who explicitly prefer background refresh independent of active sessions, multiple open-source tools use this endpoint:

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <Claude Code OAuth access token>
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/<installed-version>
Accept: application/json
```

Observed legacy response:

```json
{
  "five_hour": { "utilization": 37, "resets_at": "2026-03-10T04:59:59Z" },
  "seven_day": { "utilization": 26, "resets_at": "2026-03-15T14:59:59Z" },
  "seven_day_opus": null,
  "seven_day_sonnet": { "utilization": 1, "resets_at": "2026-03-16T20:59:59Z" },
  "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null }
}
```

Evidence includes the implementation proposal and live payload in [CCometixLine #95](https://github.com/Haleclipse/CCometixLine/issues/95), the shipped [ClaudeCodeUsage extension](https://github.com/ClaudeCodeUsage/ClaudeCodeUsage), and the cross-provider [UsageOwl provider notes](https://github.com/usageowl/usageowl/blob/main/docs/PROVIDERS.md). Parsers must be permissive: fields are nullable and plan/model-specific; newer claude.ai responses have also appeared as a `limits[]` array, though the OAuth endpoint has continued to return the legacy top-level shape.

Credentials are normally under `claudeAiOauth` in Claude Code's credential store: `~/.claude/.credentials.json` on Windows/Linux and the `Claude Code-credentials` Keychain item on macOS. `CLAUDE_CODE_OAUTH_TOKEN` can also exist. Access tokens expire, refresh tokens rotate, and Claude Code owns refresh. PolyCode should read only the access token at request time, never log it, never send it to the renderer, and never refresh or rewrite the shared credential file; concurrent refresh/write can invalidate Claude Code's state. If expired, report `reauth_required`/`stale` and let the user use Claude Code's normal login flow. On macOS, Keychain access can prompt.

The endpoint is aggressively rate-limited for some accounts. An open Anthropic repository report documents persistent 429s even at 30–120 second intervals ([anthropics/claude-code #30930](https://github.com/anthropics/claude-code/issues/30930)); community testing indicates matching the installed `claude-code/<version>` user agent may select the intended bucket ([usage-monitor research issue](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/issues/202)). Treat that as compatibility behavior, not a guarantee. Recommended polling is no more often than every 5 minutes, plus refresh on explicit user action and after a Claude turn completes, with one shared cache across all PolyCode windows. On 429, honor a positive `Retry-After`; otherwise exponential backoff (for example 5, 15, 30, then 60 minutes) and continue showing the last good snapshot as stale.

The alternative `https://claude.ai/api/organizations/{orgUuid}/usage`, used by [claude-usage-hud](https://github.com/thivanao-jp/claude-usage-hud), depends on web cookies and organization discovery. It may avoid OAuth endpoint throttling but is a worse fit: browser-session theft/cookie handling expands the security surface, it is equally undocumented, and its limits may distinguish web/mobile from OAuth-app usage. Do not use it in PolyCode.

Local transcript parsing (`~/.claude/projects/**/*.jsonl`) is useful only for burn-rate estimates and charts. It cannot authoritatively reconstruct Anthropic's server-side utilization because usage is shared across devices/surfaces and the quota formula is not public. Use it only as an optional estimate, clearly marked, when the endpoint is unavailable.

### GLM Coding Plan (optional)

Z.ai publishes an official Claude Code plugin specifically to query Coding Plan usage ([zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins/tree/main/plugins/glm-plan-usage)). Community source tracing identifies the underlying read endpoint as:

```http
GET https://api.z.ai/api/monitor/usage/quota/limit
Authorization: Bearer <GLM API key>
```

The China service equivalent is `https://open.bigmodel.cn/api/monitor/usage/quota/limit`. Observed `data.limits[]` entries use `type: "TOKENS_LIMIT"`; `(unit: 3, number: 5)` denotes the five-hour window and `(unit: 6, number: 1)` the weekly window, with `percentage` used and `nextResetTime` in epoch milliseconds. `TIME_LIMIT` represents tool/search allowances. These endpoint details remain undocumented; see the independently implemented [dsh-provider-balance notes](https://github.com/aka-danielZhang/dsh-provider-balance).

For a first version, either invoke the official GLM usage plugin/command and parse its structured result if it exposes one, or make the read call with a user-supplied key stored through PolyCode's existing credential mechanism. Do not scrape the subscription website.

## Proposed PolyCode design

Keep all network and credential work in the Electron main process:

```ts
type QuotaWindow = {
  id: string
  label: string
  usedPercent: number | null
  durationSeconds: number | null
  resetsAt: string | null
}

type SubscriptionUsageSnapshot = {
  provider: 'codex' | 'claude' | 'glm'
  plan: string | null
  windows: QuotaWindow[]
  extraUsage?: { enabled: boolean; used?: number; limit?: number; currency?: string }
  observedAt: string
  source: 'codex-app-server' | 'claude-status-line' | 'anthropic-oauth' | 'glm-monitor' | 'local-estimate'
  freshness: 'live' | 'stale' | 'estimated'
  error?: 'not_authenticated' | 'reauth_required' | 'rate_limited' | 'unavailable' | 'schema_changed'
}
```

Suggested components:

1. `CodexUsageAdapter`: long-lived app-server connection per execution location; initial read plus notifications. This is the default and most robust provider.
2. `ClaudeStatusLineAdapter`: install or document an opt-in cache helper, preserving/chaining an existing status line, and ingest its event-driven snapshot. An optional separate `ClaudeOAuthUsageAdapter` is fallback-only.
3. `GlmUsageAdapter`: optional API-key-backed monitor request.
4. `SubscriptionUsageCoordinator`: deduplicate refreshes, apply jitter, persist only non-secret snapshots/history, and publish renderer IPC updates.
5. Renderer: a compact top-bar/menu indicator showing the most constrained window, with a popover for all windows, reset times, source/freshness, refresh, and setup/reauth actions. Avoid polling separately from each component.

Poll policy: Codex notifications plus a 5-minute reconciliation read; Claude status-line ingestion is event-driven, while its optional OAuth fallback should be no faster than 5 minutes active/15 minutes background; GLM 5–15 minutes. Add 10–20% jitter to network polling and persist the last non-secret snapshot so startup does not flash empty state.

Parser policy: preserve unknown windows, clamp display percentages but retain raw values for diagnostics, accept nullable reset timestamps, validate timestamps and numeric scales, and record a redacted schema fingerprint on parse failure. Never log response headers, bearer tokens, cookies, credential-file contents, or raw payloads that might gain sensitive fields later.

## Risk assessment

| Approach | Robustness | Policy/account risk | Recommendation |
|---|---:|---:|---|
| Codex app-server RPC | High; official open-source interface | Low | Ship by default |
| OpenAI `/wham/usage` direct | Medium; private/schema-changing | Medium | Fallback only, preferably omit initially |
| Claude status-line JSON | High contract quality; event-driven and occasionally absent | Low | Ship as the default Claude path |
| Anthropic OAuth `/api/oauth/usage` | Medium-low; private and throttled | Medium | Explicit fallback only |
| Claude web-session endpoint | Low; cookie/org coupling | High | Do not ship |
| Local Claude transcript estimate | Low accuracy, high availability | Low | Optional labelled fallback |
| GLM monitor endpoint | Medium; simple but undocumented | Medium-low | Phase two/opt-in |

OpenAI's consumer Terms prohibit automatic/programmatic extraction and reverse engineering, while its business agreement also limits extracting data except as permitted through the service ([OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/), [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)). This is another reason to use the explicitly documented Codex app-server boundary instead of WHAM. Anthropic provides no public authorization for its OAuth usage endpoint, and policy violations can lead to account enforcement ([Anthropic Transparency Hub](https://www.anthropic.com/transparency/system-trust-reporting)). A read-only personal desktop integration at low frequency is materially less risky than bypassing limits or sharing credentials, but it is not zero-risk. The UI/settings should state that Anthropic and GLM monitoring relies on undocumented interfaces that may stop working, and it should be possible to disable each adapter independently.

## Implementation sequence

1. Implement the normalized model/coordinator and Codex app-server adapter.
2. Add the compact menu/popover and freshness/error states.
3. Add the Claude status-line cache helper with opt-in installation and existing-command preservation; test absent windows and stale snapshots.
4. If needed, add Anthropic OAuth as a separately enabled fallback with five-minute cache and strong backoff; test expired tokens, 401, 403, 429, null windows, and schema drift.
5. Collect only redacted operational telemetry (provider, status code class, latency, source, freshness), never account identifiers or payloads.
6. Add GLM after confirming the official plugin's current executable/output contract on all supported execution locations.
