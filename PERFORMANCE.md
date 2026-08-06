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
**Last evidence review:** 2026-08-06  
**Log source:** `%APPDATA%/polycode-electron/logs/app-2026-08-06.log`

The evidence supports two primary causes:

1. Synchronous filesystem work blocks Electron's main process.
2. Independent UI pollers create overlapping bursts of git and forge operations.

Renderer work contributes some shorter long tasks, but the clearest multi-second freezes
currently correlate with main-process stalls.

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

## Remediation tracker

| Priority | Work item | State | Success signal |
| --- | --- | --- | --- |
| P0 | Cache and deduplicate favicon requests | Monitoring | One discovery per project; repeated calls below 10 ms |
| P0 | Remove synchronous recursive favicon scan from main thread | Monitoring | No main-thread stall correlated with `projects:favicon` |
| P0 | Introduce a shared per-repository refresh coordinator | Not started | One in-flight status refresh per repository |
| P0 | Remove duplicate component-owned git polling | Not started | No duplicate status/last-commit refresh window |
| P0 | Stagger and limit sidebar branch refreshes | Not started | `git:branch` peak concurrency at or below configured limit |
| P1 | Add forge caching and failure backoff | Not started | Failing forge calls do not recur every refresh cycle |
| P1 | Add visibility/focus-aware polling | Not started | No periodic git/forge work from hidden views |
| P1 | Add per-command timing within composite git operations | Not started | Slow outer IPC calls identify their slow child command |
| P2 | Audit remaining synchronous main-process I/O | Not started | Proven hot paths have owners and disposition |
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
