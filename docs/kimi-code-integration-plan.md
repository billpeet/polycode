# Kimi Code CLI integration scope

Assessment date: 2026-09-18. PolyCode baseline: `e76ff9d`. Target: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), not the legacy Python CLI. The proposal below records the original scope. Implementation status follows here.

## Implementation status

Implemented provider `kimi-code` using a persistent ACP connection, with session resume, streamed text/thinking/tools, model discovery, persisted thinking choices, permission modes, plan review through blocking choices, structured question forms, context usage, and local image or embedded image input. Desktop and mobile expose the provider and its controls. Health checks validate ACP identity before treating a binary as Kimi Code or updating it. Automated Routines reject Kimi Code until upstream lifecycle gaps are resolved.

The published npm CLI `@moonshot-ai/kimi-code@2.0.0` was launched on native Windows in a fresh temporary `KIMI_CODE_HOME`. Its actual initialization response confirmed protocol version 1, agent name `Kimi Code CLI`, version `2.0.0`, session resume/close/delete capabilities, images, and form-capable ACP. An unauthenticated `session/new` returned error `-32000`, as expected. No real credentials were read by this isolated probe, and no paid prompt or authenticated SSH/WSL session was exercised.

The adapter has scripted ACP tests for startup, persistence, replay suppression, partial tool updates, permissions, plan review, multiple questions, typed arrays, unsupported forms, cancellation races, process failures, images, and discovery cleanup. Session tests verify structured answers survive the shared lifecycle and invalid answers remain pending. Health tests cover legacy detection and the native/package-aware updater. Typecheck, lint, and production build passed during implementation. The first full test run had one WSL login-banner failure in an existing Runner test; the affected test passed on rerun. Kimi startup now explicitly tolerates pre-protocol shell banners.

Known limits remain as scoped: no billing totals or quota, no in-flight steering, no audio/video, offered-choice questions only, no external-session import/fork UI, and no Routines. SSH/WSL image paths are rejected with an explanation; embedded image data is accepted. Kimi may still report non-authentication failures as `end_turn`; ACP completion must not be treated as proof of successful autonomous work.

Final full-suite rerun passed with 1,494 tests passed and 15 skipped. The temporary smoke-test binary was installed in pnpm's cache, not as a global `kimi` installation.

## Recommendation

Add provider ID `kimi-code`, display name `Kimi Code`, backed by a persistent `kimi acp` process at the Thread's Project Location. Use the existing Driver, Runner, Session, persistence, and remote-control contracts. Keep Kimi responsible for authentication, model calls, tools, configuration, and its own session files.

ACP is the best fit because PolyCode already uses it for Cursor and Grok. Kimi's dedicated ACP implementation supports the session lifecycle and interactive controls we need. Using its internal engine packages would couple PolyCode to a second application's implementation. Parsing terminal output would discard the structured interface already available. Do not implement the legacy CLI's Wire protocol.

Upstream evidence and pinned source links are in [the upstream research](kimi-code-upstream-research.md). The [official ACP reference](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/docs/en/reference/kimi-acp.md) describes the supported methods; the source is the authority where documentation and implementation differ.

## Comparison with providers already in PolyCode

This table describes our current adapters, not every feature the upstream products offer.

| Provider | Current integration | Relevant precedent for Kimi |
| --- | --- | --- |
| Claude Code | Agent SDK, streamed messages and permission callbacks | Rich questions and permissions already have UI and Session handling. Kimi does not need the Claude SDK. |
| Codex | Persistent local app-server; CLI JSON fallback for SSH/WSL | Session IDs, streaming, cancellation, usage, and background-work lifecycle. Kimi can use the same ACP transport across locations instead of introducing two paths. |
| OpenCode | `opencode run --format json`, process per turn | Small driver, but this execution pattern is a poor match for Kimi's interactive questions and approvals. |
| Pi | Persistent `pi --mode rpc` | Persistent process lifecycle and in-flight steering. Do not assume Kimi has Pi's steering command. |
| Cursor | Persistent `cursor-agent acp` | Closest model/config picker precedent; contains Cursor-specific question and plan behavior that must not be copied. |
| Grok Build | Persistent `grok agent stdio` | ACP startup, model discovery, and permission option mapping; its auth and prompt-completion extensions are Grok-specific. |
| Kimi Code, proposed | Persistent `kimi acp` through Runner | Reuse architecture; implement Kimi capabilities, questions, modes, and lifecycle explicitly. |

Local evidence: [driver contract](../apps/desktop/src/main/driver/types.ts), [Claude](../apps/desktop/src/main/driver/claude.ts), [Codex](../apps/desktop/src/main/driver/codex.ts), [OpenCode](../apps/desktop/src/main/driver/opencode.ts), [Pi](../apps/desktop/src/main/driver/pi.ts), [Cursor](../apps/desktop/src/main/driver/cursor.ts), [Grok](../apps/desktop/src/main/driver/grok.ts).

## Driver and session lifecycle

1. Spawn `kimi acp` through `createRunner`, with the Project Location as working directory and stdin kept open. Advertise no client filesystem or terminal delegation initially. Kimi then operates where its process runs, including SSH and WSL, rather than asking PolyCode to execute remote tools locally.
2. Negotiate `initialize`, validate agent identity and capabilities, and inspect authentication requirements. Both generations use the executable name `kimi`, so a successful `kimi --version` alone must not count as compatibility. Show an actionable error for a legacy binary or an unsupported protocol.
3. Use `session/new` for a new Session. Persist its external ID through the existing callback and `claude_session_id` column, which already stores other providers' IDs. A column rename is unrelated work.
4. Prefer advertised `session/resume` when reopening a stored conversation. PolyCode already persists its transcript. If only `session/load` is available, suppress historical output during loading so messages, tool calls, and usage are not inserted twice. A missing or invalid session must produce a recovery choice, not silently start an empty conversation.
5. Apply the selected model and mode before `session/prompt`. Use returned config options and refreshes to keep controls accurate. If a requested model cannot be applied, report that failure rather than silently run another model.
6. Translate text, thought, tool, plan, and context events into `OutputEvent`. Keep per-tool state across partial updates, preserve IDs, results, errors, file locations, and diffs. Completion must settle once even if cancellation and process exit race.
7. Stop via the advertised ACP cancellation behavior, then terminate the process tree after a bounded grace period if necessary. Session destruction and application shutdown must also close idle processes and clear pending callbacks.

The existing `CLIDriver.sendMessage` comment says it spawns a process per call, but several implementations already keep a process alive. Fix the comment when adding this driver; do not change the interface merely to satisfy the stale comment.

## Controls and event mapping

| Area | Proposed behavior | Work or constraint |
| --- | --- | --- |
| Models | Discover from session `configOptions`, with an explicit CLI-default choice | Add `kimi-models.ts` and a location-aware model channel/cache. Avoid hard-coded Kimi model assumptions. Close disposable discovery sessions and avoid accumulating empty histories. |
| Thinking | Render exactly the advertised options | Kimi supports both boolean-like `off`/`on` and model-specific effort choices. Our `ReasoningLevel` cannot represent `on`, and the existing thinking field is Cursor-specific. Add a small provider-neutral persisted setting or an explicitly Kimi-specific one; do not overload `high` to mean `on`. |
| Permissions | Map Ask to `default`, Auto to `auto`, Yolo to `yolo` | Choose actual offered option IDs by kind. Never reuse Cursor's literal `allow-once`. No Codex-style Workspace mode unless Kimi later advertises equivalent semantics. |
| Questions | Implement `elicitation/create` forms and translate them into the existing question UI | Preserve question IDs, arrays, and typed answers. `Session.answerQuestion` currently joins arrays and rekeys answers by question text; add a compatible structured path. Unsupported form schemas need an explicit response, not a hanging request. |
| Question fallback | Recognize question requests on `session/request_permission` separately from approvals | Kimi's fallback is only single-question/single-select. Yolo must never automatically choose a user's answer. |
| Plans | Treat ACP plan updates as progress, and plan-review requests as blocking interactions | PolyCode's `plan_ready` flow assumes turn completion; a blocking ACP review needs a response on the same request. Preserve approve/revise/reject choices. Do not copy Cursor's automatic acceptance. |
| Tools | Normalize using known tool inputs, ACP kind, locations, and content | Kimi titles can describe an action rather than identify a tool. Keep raw metadata for unknown tools and avoid misclassifying edits/searches. |
| Context usage | Show reported context occupancy and limit | Context size is not billable token consumption. Kimi emits usage asynchronously after prompt settlement, so keep a session-level event path alive after clearing the current turn. Keep unsupported cost/quota data unavailable. |
| Images | Map saved attachments to supported ACP image content | Validate MIME/size and resolve attachment bytes correctly across locations. A desktop path is not a remote path. |
| Mid-turn input | Initially disable sending while running, or explicitly queue for the next turn | The current Session ignores sends when a driver lacks `injectMessage`. Do not expose a control that silently loses input. |

These mappings follow the upstream [mode source](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/packages/acp-server/src/modes.ts), [config options](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/packages/acp-server/src/config-options.ts), [question bridge](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/packages/acp-server/src/question.ts), and [approval bridge](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/packages/acp-server/src/approval.ts). Local contracts: [Session](../apps/desktop/src/main/session/session.ts), [shared types](../packages/shared/src/types.ts), [tool normalization](../packages/shared/src/tools.ts).

## Repository changes

| Area | Files or modules |
| --- | --- |
| Provider registration and defaults | `packages/shared/src/types.ts`; add provider, default model, capability-aware settings |
| Driver and dispatch | New `apps/desktop/src/main/driver/kimi.ts`, optional `kimi-acp.ts` helpers; `session/session.ts` dispatch and structured answers |
| Models and remote contract | New `main/kimi-models.ts`; `main/ipc/channel-handlers.ts`; shared `channels.ts` and `channel-contract.ts` |
| Health and update | `main/health/checker.ts`; package `@moonshot-ai/kimi-code`, executable `kimi`, updater `kimi upgrade --yes`; verify identity and Windows shell dependency |
| Desktop controls | `ComposerToolbar.tsx`, `ModelSelectorMenu.tsx`, `ProviderIcon.tsx`, `RoutineEditModal.tsx`; use actual supported controls |
| Mobile | `src/lib/models.ts`, `src/api/rpc.ts`, `ThreadControls.tsx`, question/permission rendering as needed |
| Persistence | Reuse provider/model/external session storage; add a setting migration only where new thinking/config values require it |
| Documentation | README installation/authentication/platform notes and provider list |

Extract only the small, demonstrably common ACP transport pieces if useful. A broad rewrite of Cursor and Grok is not a prerequisite. Their custom extensions, timeout behavior, and permission assumptions are precisely why a subclass or copy-and-rename is risky.

## Likely limitations and release gates

- Installation and login belong to each execution environment. Windows requires Git Bash, including `KIMI_SHELL_PATH` for custom installs. Local login does not authenticate a separate SSH host or WSL installation. Start with CLI-owned login; do not build credential storage into PolyCode. See [installation guidance](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/docs/en/guides/getting-started.md).
- The same executable name can resolve to legacy Kimi CLI. Detect this before presenting supported controls or running an updater. Never migrate or replace a legacy installation merely because a health check finds it.
- Thinking choices and modes depend on the installed CLI/model. Capability discovery is required; test a pinned released version and set the minimum supported version from that evidence, not from current `main` alone.
- Question forms do not automatically provide the same free-text comments and Other behavior as PolyCode's existing UI. Preserve supported fields and explain unsupported answers instead of discarding them.
- Plan review is more than binary permission. Ship full mode support only after the live review request can be answered without prematurely completing the turn or bypassing user review.
- ACP context usage does not establish input/output billing totals, USD cost, or subscription quota. Do not infer charges from context occupancy.
- Failure reporting needs verification. In the examined ACP source, `onTurnEnded` rejects authentication failures, but other failed turns can resolve with `end_turn`. A normal prompt response is therefore not sufficient evidence of success. Capture real provider failures in the spike and establish a reliable signal or upstream fix before treating completion as success in automated Runs. See [session handling](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/packages/acp-server/src/session.ts) and [stop-reason mapping](https://github.com/MoonshotAI/kimi-code/blob/f233f9de04d71c42d27df870b18e1bc1a6605f16/packages/acp-server/src/events-map.ts).
- Do not promise audio/video attachment parity from terminal features. The ACP input contract is narrower. Text and images are the initial target.
- Native session import, fork UI, skills discovery, plugin/MCP management, background-terminal controls, and auxiliary title generation are separate follow-up scope. Existing CLI-configured tools and skills may work without a PolyCode management UI.
- Background work needs a concrete lifecycle decision before enabling Kimi for automated Runs. A finished prompt does not prove that subagents or shell tasks have stopped. Either expose reliable background-work tracking/teardown or keep Kimi unavailable for Routines until cleanup safety is verified.

## Delivery sequence and acceptance checks

1. **Protocol spike.** Use a pinned released Kimi Code binary. Capture sanitized startup, prompt, tool, approval, question, resume, cancellation, and failure transcripts. Verify advertised capabilities against actual behavior on native Windows first, then SSH and WSL. This decides the minimum version and any platform restrictions.
2. **Core provider.** Register the provider and implement persistent ACP, text/thinking/tools, model discovery, resume without duplicate history, permissions, stop/error handling, and health/update support. Wire both desktop and mobile. Release gates include no silent model fallback, no ignored user messages, and no dangling request after stop.
3. **Interactive completion.** Add structured question answers and plan review; persist thinking choices accurately; implement attachment and context reporting. These are meaningful integration work, not icon/picker polish. Hide incomplete controls during development.
4. **Lifecycle and regression validation.** Verify remote paths/auth, app shutdown, idle process cleanup, reconnect, stale sessions, and background work. Enable Routines only after their cleanup invariant holds. Run targeted driver/session/channel tests, then repository typecheck, lint, and relevant existing ACP regressions.

Test the adapter with recorded/fake ACP transcripts for split JSON frames, out-of-order tool updates, actual permission IDs, multi-select answers, replay suppression, request rejection, process exit, and cancellation races. Live smoke tests should include a read, approved edit, denied command, question, resumed conversation, and stopped long-running command. No tests were run for this documentation-only assessment.

This is a medium-sized provider integration. The transport is familiar; the effort lies in faithfully representing questions, plan review, thinking options, and process lifecycle. The protocol spike should establish the implementation estimate before committing to a delivery date.
