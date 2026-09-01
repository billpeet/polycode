# Performance Investigation

This document tracks PolyCode's UI responsiveness investigation, the evidence gathered,
and progress against proposed fixes. Update it after each performance change and profiling
session so conclusions remain tied to measurements.

## User-visible symptoms

- The input bar becomes unresponsive or appears disabled for several seconds.
- Messages stop updating temporarily.
- The git panel becomes unresponsive.
- Slowdowns occur while background project, git, and forge operations are active.

## Current status

**Investigation state:** Active  
**Last evidence review:** 2026-08-07, through 08:09 AEST
**Log source:** `%APPDATA%/polycode-electron/logs/app-2026-08-06.log`

The evidence supports two primary causes:

1. Synchronous filesystem work blocks Electron's main process.
2. Independent UI pollers create overlapping bursts of git and forge operations.

Renderer work contributes some shorter long tasks, but the clearest multi-second freezes
currently correlate with main-process stalls.

### Post-P0 monitoring update

The first approximately four-minute session after restarting with the P0 changes showed a
material responsiveness improvement:

- No renderer event-loop stalls and no renderer frame-jank events.
- Three renderer long tasks: 61 ms, 109 ms, and 235 ms.
- Two main-process stalls: 453 ms and 276 ms. Both occurred during multi-repository git
  activity; neither correlated with favicon discovery.
- Startup favicon discovery remained slow in wall-clock terms (11 projects, average 1,054 ms,
  maximum 3,508 ms), but it ran asynchronously without a recorded main-thread stall.
- Sidebar branch refresh peak concurrency was two, matching the configured worker limit.
- Status/last-commit concurrency reached two only when different repositories refreshed in
  the same window. The per-repository coordinator and in-flight deduplication remain consistent
  with the observed logs.
- Forge PR list/current calls continued to fail on nearly every refresh because the installed
  `gh` version rejects the `reviewThreads` JSON field. These calls commonly consumed 350-650 ms
  and occasionally exceeded one second.

The longer observation period changes the initial assessment. The log contains two distinct
post-P0 sessions:

| Session | Duration observed | Main stalls | Renderer stalls | Notable maximum |
| --- | ---: | ---: | ---: | --- |
| Started 11:36:08 AEST | 25.8 minutes | 21 | 3 | Main 1,075 ms; renderer 1,760 ms |
| Started about 12:36:31 AEST | 16.3 minutes through latest sample | 12 | 14 | Main/favicon 14,605/14,584 ms; renderer 1,571 ms |

The second startup disproves the stronger initial conclusion that asynchronous favicon scanning
was sufficient. Fourteen favicon requests ran during startup, and one recursive discovery took
14,584 ms while the main event loop stalled for 14,605 ms. Although the filesystem API is now
asynchronous, many concurrent recursive walks can still saturate the main process and underlying
I/O. Per-project caching/deduplication works, but cross-project discovery remains unbounded.

The first session also contained a 1,075 ms main stall during a large Azure DevOps forge burst:
multiple `where.exe azdevops.cmd`, PR list, and per-PR comment processes were launched close
together. This strengthens the recommendation to cache, back off, and concurrency-limit forge
work.

Very large `frame-jank` gaps coincide with long periods without log activity and likely include
background-window throttling, suspension, or debugger pauses. They are not counted as proven UI
freezes by themselves. Renderer event-loop stalls of 284-1,760 ms remain actionable.

P0 remains in `Monitoring`, with favicon cross-project concurrency requiring follow-up before the
favicon work can be considered complete. The target of no main-process stall over 250 ms is not met.

### Overnight steady-state update

The 2026-08-07 log covers approximately 8.15 hours and provides a much stronger steady-state
baseline:

- 263 main-process stalls, with a maximum of 1,975 ms. Most severe stalls occurred close to
  `:29-:30` and coincided with sidebar branch sweeps.
- Nine renderer event-loop stalls. Two very large samples (37 seconds and 7 seconds) likely
  include suspension/background throttling; the remaining actionable samples were 218-785 ms.
- Forty renderer long tasks, all at or below 143 ms.
- No favicon IPC calls. Favicon remains a startup risk but is not contributing to this
  steady-state sample.

Aggregated IPC cost from ten-second summaries:

| Channel | Calls | Average | Maximum | Total observed time | Errors | Peak concurrency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `git:status` | 211 | 816 ms | 3,390 ms | 172.2 s | 0 | 1 |
| `git:branch` | 1,651 | 102 ms | 1,482 ms | 168.1 s | 0 | 4 |
| `git:lastCommit` | 204 | 408 ms | 2,057 ms | 83.1 s | 0 | 1 |
| `git:fetchRemote` | 21 | 1,141 ms | 2,275 ms | 24.0 s | 0 | 1 |
| `forge:pr:list` | 22 | 728 ms | 3,982 ms | 16.0 s | 21 | 1 |
| `forge:pr:current` | 21 | 558 ms | 1,311 ms | 11.7 s | 21 | 1 |

The sidebar code limits each branch sweep to two workers, but it does not prevent the next
ten-second interval from starting while a prior sweep is still running. This explains observed
peak concurrency of four. Expanded projects and accumulated worktrees make each sweep longer and
more expensive. At 21:57 UTC, branch calls rose from 468 ms to 1,995 ms across the queue while a
status, last-commit, and remote fetch ran for the active worktree; the main process stalled for
1,975 ms.

Git status is the largest aggregate cost. Its 211 refreshes typically run a sequence of branch,
upstream, ahead/behind, porcelain status, and diff-stat commands. It should be reduced and
coordinated with sidebar and remote refresh work rather than merely moved to a worker.

Forge PR discovery remains wasteful: 21 of 22 list calls and all 21 current-PR calls failed.
Failure backoff is now a high-confidence, low-risk improvement.

## Instrumentation available

The app logs the following profiling events:

| Marker | Meaning |
| --- | --- |
| `[perf][renderer] event-loop-stall` | Renderer timer delayed by at least 200 ms |
| `[perf][renderer] long-task` | Chromium renderer long task of at least 50 ms |
| `[perf][renderer] frame-jank` | Large gap between animation frames |
| `[perf][renderer] react-commit:*` | Slow React commit |
| `[perf][renderer-ipc]` | IPC latency observed by the renderer |
| `[perf][ipc]` | Individual slow IPC handler in the main process |
| `[perf][ipc-summary]` | Ten-second per-channel count, latency, errors, and concurrency |
| `[perf][main-thread] event-loop-stall` | Electron main-process event-loop delay |

App log writes are buffered asynchronously. A synchronous flush remains at shutdown to
preserve queued entries.

## Baseline observations

The first instrumented log review found:

- 747 recorded main-process stalls.
- 25 renderer event-loop stalls and 61 renderer long tasks.
- Credible interactive stalls in the 300-1,900 ms range.
- Larger samples may include machine sleep, application suspension, or debugger pauses and
  should not be treated as interactive freezes without supporting events nearby.

Representative correlated windows:

| Operation/window | Observed duration | Correlated evidence |
| --- | ---: | --- |
| `projects:favicon` | 2,457 ms | 1,818 ms main-process stall |
| `projects:favicon` | 2,125 ms | 1,899 ms main-process stall |
| Three concurrent `git:branch` calls | 1,020-1,236 ms each | 670 ms and 909 ms main-process stalls |
| `git:compareToMain` | 2,832 ms | Git/forge-heavy refresh window |
| `git:status` | 1,560 ms | Same refresh window |
| `git:lastCommit` | 1,245 ms | Same refresh window |
| Forge PR operations | 764-1,415 ms | Repeated failures and retries during refreshes |

## Findings

### P0: Favicon discovery performs synchronous recursive filesystem scans

`projects:favicon` can scan up to 5,000 directory entries to depth five. The implementation
uses `readdirSync`, `statSync`, and `readFileSync` in the Electron main process. Calls lasting
over two seconds directly coincide with main-thread stalls of almost two seconds.

**Recommendation**

- Make discovery asynchronous or execute it outside the main process.
- Cache results by project path, including a negative result when no favicon exists.
- Deduplicate concurrent requests for the same project.
- Prefer known favicon candidates and manifest/source references before any bounded fallback
  scan.
- Consider removing recursive fallback discovery if its UI value does not justify its cost.

### P0: Multiple components independently poll git state

Known refresh owners include:

- `Sidebar`: polls `git:branch` for every location in every expanded project every 10 seconds
  using an unbounded `Promise.all` burst.
- `ThreadHeader`: polls full git status every 10 seconds and remote state every 60 seconds.
- `GitSection`: initiates its own git refresh when visible.
- File preview and tree components have additional five-second refresh loops.

The git store prevents duplicate full `fetch` calls for one path while one is already marked
loading, but it does not coordinate all git channels or all repositories. Logs show branch
concurrency of four and synchronized work across several repositories.

**Recommendation**

- Establish one refresh coordinator per repository.
- Deduplicate in-flight calls by operation and normalized repository path.
- Replace component-owned polling with subscriptions to shared cached state.
- Do not poll hidden or collapsed views.
- Pause or reduce polling while the window is unfocused or minimized.
- Stagger multi-repository refreshes and enforce a small concurrency limit.
- Prefer file-watch invalidation plus a debounced refresh over fixed polling where reliable.

### P1: Git status refresh invokes several child processes

A single status refresh launches commands for branch/upstream state, ahead/behind counts,
porcelain status, and diff statistics. `git:lastCommit`, compare, and branch calls add more
processes. Child processes are asynchronous, but large synchronized bursts increase CPU,
I/O, process creation, result parsing, and IPC completion work.

**Recommendation**

- Share results needed by status, branch, and last-commit consumers.
- Combine compatible git queries where practical.
- Add short-lived caching and invalidation after known mutations.
- Record child-command timing inside composite git operations to identify the expensive
  command rather than only the outer IPC duration.
- Consider a worker only for remaining CPU-heavy parsing or synchronous library work after
  duplicate work is removed.

### P1: Forge requests repeatedly fail and are retried

`forge:pr:list` and `forge:pr:current` repeatedly failed while taking hundreds of milliseconds
to more than one second. Related PR URL/default-branch queries run in the same refresh path.

**Recommendation**

- Cache forge metadata independently from fast local git status.
- Apply exponential failure backoff and expose a manual retry.
- Avoid refreshing forge data when its panel is hidden.
- Avoid repeating invariant repository URL/provider queries on every refresh.

### P1: Other synchronous main-process paths remain

The main process contains synchronous filesystem and process calls in file browsing, plan
watching, history import, skills discovery, WSL helpers, attachments, and thread logging.
They are not all proven contributors to the observed freezes.

**Recommendation**

- Instrument these paths before broad conversion.
- Prioritize any synchronous operation whose timing correlates with a main-thread stall.
- Convert proven hot paths to asynchronous I/O or isolate them in worker processes.

### P0: Worktree deletion ran a synchronous recursive delete on the main thread

`removeWorktreeLocation` fell back to `rmSync(path, { recursive: true })` whenever
`git worktree remove --force` could not clean the directory — the common case on Windows
(Directory not empty, Permission denied, Filename too long). Worktrees routinely hold tens
of thousands of files (per-worktree `node_modules`), so the delete ran for seconds to
minutes entirely on Electron's main process: the whole UI, and the composer in particular,
froze until the worktree was gone.

**Resolution**

- `removeWorktreeDirectoryBestEffort` now awaits `fs.promises.rm`, which executes on the
  libuv threadpool; the main process stays responsive for the full deletion.
- The same handler now archives every thread at the location up front (`
  archiveThreadsForLocation`), so the Queue empties the moment deletion is triggered rather
  than after teardown, and message-less threads are archived instead of hard-deleted so
  the worktree's threads stay recoverable.

## Remediation tracker

| Priority | Work item | State | Success signal |
| --- | --- | --- | --- |
| P0 | Cache and deduplicate favicon requests | Monitoring | One discovery per project; repeated calls below 10 ms |
| P0 | Remove synchronous recursive favicon scan from main thread | Monitoring | No main-thread stall correlated with `projects:favicon`; cross-project discovery must be bounded or moved off-process |
| P0 | Introduce a shared per-repository refresh coordinator | Monitoring | One in-flight status refresh per repository |
| P0 | Remove duplicate component-owned git polling | Monitoring | No duplicate status/last-commit refresh window |
| P0 | Prevent overlapping sidebar branch sweeps and reduce branch polling scope | Monitoring | `git:branch` peak concurrency at or below two; no minute-boundary main stalls correlated with branch sweep |
| P1 | Reduce and coordinate full git status/last-commit refreshes | Monitoring | Lower call count and aggregate cost without stale active-repository state |
| P1 | Add forge caching and failure backoff | Monitoring | Failing forge calls do not recur every refresh cycle |
| P1 | Add visibility/focus-aware polling | Not started | No periodic git/forge work from hidden views |
| P1 | Add per-command timing within composite git operations | Not started | Slow outer IPC calls identify their slow child command |
| P2 | Audit remaining synchronous main-process I/O | In progress | Proven hot paths have owners and disposition |
| P0 | Delete worktree directories off the main thread (`fs.promises.rm`) | Monitoring | No main-process stall correlated with `locations:removeWorktree` |
| P2 | Evaluate workers after deduplication | Not started | Worker proposal tied to measured CPU/blocking work |

States should be one of: `Not started`, `In progress`, `Monitoring`, `Complete`, or `Rejected`.

## Validation protocol

For every performance fix:

1. Record the affected marker and baseline latency/concurrency above.
2. Make one focused change where possible.
3. Run type checking, linting, and desktop tests.
4. Reproduce the same interaction for at least five minutes.
5. Compare main-thread stalls, renderer stalls, IPC maximum/average latency, call count, and
   peak concurrency.
6. Record the result in the experiment log below.
7. Keep the change only if it improves the target measure without introducing stale UI data.

Suggested initial targets:

- No main-process event-loop stall over 250 ms during ordinary idle polling.
- No renderer event-loop stall over 200 ms during typing or message streaming.
- No duplicate in-flight `git:status`, `git:lastCommit`, or forge request for one repository.
- Background refresh concurrency no greater than two repositories at once.
- Favicon lookup does not block the main process and is served from cache after first lookup.

## Experiment log

| Date | Change | Scenario | Before | After | Result/notes |
| --- | --- | --- | --- | --- | --- |
| 2026-08-06 | Added renderer/main/IPC instrumentation and buffered app logging | Normal use with project switching, messages, and git panel activity | No attributable measurements | Main and renderer stalls correlated with favicon and git/forge bursts | Baseline established |
| 2026-08-06 | Made favicon discovery asynchronous; cached positive/negative results and deduplicated in-flight requests by project path | Automated favicon discovery and concurrency tests | 2,125-2,457 ms IPC calls with 1,818-1,899 ms main stalls | Awaiting five-minute profiling session | Implementation complete; monitoring required |
| 2026-08-06 | Centralized visible git status/remote polling by repository; shared in-flight status promises; limited sidebar branch refreshes to two workers | Automated type checking, linting, and tests | Duplicate component timers and branch concurrency up to four | Awaiting five-minute profiling session | Implementation complete; monitoring required |
| 2026-08-06 | First post-P0 live session after 11:36:08 AEST restart | Approximately four minutes of project switching, message activity, and background refreshes | Frequent multi-second main/renderer stalls; branch concurrency up to four | No renderer stalls; two main stalls at 453 ms and 276 ms; branch concurrency limited to two; no favicon-correlated stall | Material improvement. Continue monitoring; forge failures are now the clearest repeated waste |
| 2026-08-06 | Extended post-P0 monitoring across two sessions | 25.8-minute session plus 16.3 minutes after a second restart | Initial four-minute sample looked healthy | Session 1: 21 main and 3 renderer stalls; session 2: 12 main and 14 renderer stalls. Second startup had a 14,584 ms favicon call and 14,605 ms main stall | P0 reduced duplicate git work but responsiveness target is not met. Bound cross-project favicon discovery and prioritize forge burst control |
| 2026-08-07 | Overnight steady-state review | 8.15 hours | Short post-restart samples | 263 main stalls; branch concurrency four; 1,651 branch calls; 211 status calls; forge failures on 42 of 43 list/current calls | Next priority is preventing overlapping branch sweeps, followed by reducing composite status work and backing off forge failures |
| 2026-08-07 | Made sidebar branch refresh single-flight, visible-scope, mutation-invalidated, and two-worker; reduced fallback branch/status polling to 120/60 seconds and stopped polling last commit when the branch is unchanged | Automated type checking, linting, and coordinator tests | Ten-second sweeps could overlap to four branch calls; status and last commit both ran every ten seconds | One sweep at a time with at most two calls; hidden/collapsed locations excluded; known branch mutations trigger refresh | Implementation complete; five-minute profiling session required before marking complete |
| 2026-08-07 | Made git status refresh selected-repository-only and watcher-driven; cached last-commit by exact HEAD; moved fallback status polling to five minutes and staggered remote fetch by 30 seconds | Automated type checking, linting, and coordinator tests | 211 status and 204 last-commit calls; status/remote/branch work often overlapped | Only active repository is watched/refreshed; last-commit runs only when `rev-parse HEAD` changes; remote/status work is serial and offset | Implementation complete; profiling required to measure call-count and stall reduction |
| 2026-08-07 | Removed unsupported GitHub `reviewThreads` JSON field; cached forge metadata; added deterministic failure suppression, transient exponential backoff, request deduplication, and forced manual retry | Automated type checking, linting, and backoff tests | 42 of 43 list/current calls failed and were retried automatically | Deterministic failures stop automatic calls; transient retries back off from 30 seconds to 15 minutes; panel Retry bypasses suppression | Implementation complete; profiling required to confirm failing calls no longer recur |
| 2026-08-07 | Serialized favicon discovery globally; persisted positive and negative results across restarts; reduced recursive fallback to depth four and 1,500 entries | Automated type checking, linting, favicon discovery/cache tests | Startup could run 14 recursive scans concurrently and stall main for 14.6 seconds | At most one uncached discovery runs; cached paths are revalidated by mtime; negative results expire after 24 hours | Implementation complete; startup profiling required before deciding whether traversal also needs a worker |
| 2026-08-07 | Replaced the synchronous `rmSync` fallback in worktree removal with `fs.promises.rm`; archive all threads at the location before teardown | Deleting a worktree holding tens of thousands of files on Windows, where `git worktree remove` commonly fails its own directory cleanup | `rmSync` ran on the main process for the full recursive delete: UI and composer frozen until deletion finished | Deletion runs on the threadpool; the Queue empties immediately at trigger time because archiving precedes git teardown | Implementation complete; awaiting a repro session with a large worktree to confirm no `locations:removeWorktree`-correlated stall |

## Open questions

- Which user action occurred during each reported slowdown: typing, switching projects,
  opening the git panel, or streaming messages?
- Are sidebar branch labels required to update every 10 seconds, or only after focus and git
  mutations?
- Can recursive favicon discovery be removed entirely?
- Are forge failures authentication/configuration failures that should disable automatic
  retries until settings change?
- After deduplication, does message streaming still produce independently reproducible
  renderer stalls?
