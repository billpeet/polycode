# Native process crash diagnostics

Unexpected renderer and child-process exits produce a fatal local log and OTLP log,
and a Sentry event in production. Clean exits are ignored. Reports include the exit
reason and code, process category, versions, GPU status, latest memory samples with
timestamps, last reported workspace view category, and up to 40 recent IPC/stall
breadcrumbs. A sample may predate a crash by 30 seconds or more. The view is the
last selected workspace category, not a record of keyboard focus. GPU child crashes
also carry the latest workspace category and up to 20 timestamped view changes.
These are allowlisted categories, never file names, thread IDs or page URLs.

GPU adapter IDs, active adapter, driver vendor/version and a small set of graphics
flags are cached from `app.getGPUInfo('basic')` after ready and on GPU info updates.
Only explicitly selected fields are included; arbitrary Chromium fields and device
descriptions are omitted. `sampledAt` shows the age of this best-effort sample; it
can be missing or stale if the GPU is unavailable. No complete GPU query is made
while handling a crash.

`latestUploadedReport` contains Electron's latest crash-report upload ID and date
when available. It is explicitly **not correlated to this incident**: Electron
does not expose a per-exit minidump ID, and an upload may lag or belong to an older
crash. Missing, unuploaded or unavailable reports are represented by null. See
[Electron's crash reporter API](https://www.electronjs.org/docs/latest/api/crash-reporter).

Electron reports each affected process separately, so exits that arrive within
1.5 seconds of the first are one incident: one Sentry event and one OTLP log,
fingerprinted by the triggering process type, reason and exit code, with every
exit listed in the context. The trigger is the first exit that was not merely
`killed`. An incident of kills alone is reported as a warning, not a fatal. The
local log still records every exit as it happens, because the main process may
not outlive the burst.

Shutdown teardown exits are logged locally and not reported. Genuine `crashed`
and `oom` exits are retained even during shutdown. Shutdown starts at
`before-quit`, which covers closing the app, installing an update and the GPU
diagnostic relaunch. On Windows, `before-quit` is not emitted when the machine
shuts down, restarts or logs off, so a window's `query-session-end` or
`session-end` event also counts, as does a process killed with exit code
`0x40010004`, which Windows uses for processes it terminates while ending the
session. A Windows signal suppresses reports for 60 seconds, because a shutdown
can still be cancelled. Signals that arrive during an incident's 1.5 seconds
suppress teardown incidents. In GitHub #97, a Windows Update restart killed
PolyCode's processes, Chromium's relaunches failed, and Chromium ended the app
with "GPU process isn't usable. Goodbye."; that produced about 21 fatal events
and a native minidump with no defect behind them.

Webview reports use a SHA-256 hash of the Project Location ID. Reports omit page
URLs, paths, IPC arguments, and arbitrary child service names. Child processes use
the Electron process type as their diagnostic name. Local logs flush immediately;
Sentry and OTLP get up to two seconds before recovery is presented.

Renderer recovery reloads the affected webContents, including a guest when only a
browser tab fails. After three incidents within five minutes in the same app run,
recovery also offers a restart with GPU disabled. A GPU failure on a subsequent
launch also offers this recovery after one prior GPU incident, even when neither
launch had three incidents. Utility-only exits and shutdown-suppressed incidents
do not count toward GPU recurrence. Already GPU-disabled launches do not offer
another GPU-disabled restart. Restart stops running
sessions. The diagnostic launch option is `PolyCode.exe --disable-gpu`; closing
that instance and launching normally restores the usual graphics configuration.

`gpu-crash-history.json` in the profile's user-data directory atomically persists
up to 20 GPU incidents and 20 launches retained for 30 days. It stores launch IDs,
timestamps, GPU-disabled state, exit codes, app versions and recovery observation
duration/counts, without activity payloads or GPU descriptions. Corrupt history
is replaced; a disk failure is logged without blocking crash reporting/recovery.
Deduplicated GPU incidents are persisted before exporter flushing or recovery.

GPU-disabled launches checkpoint observation time every five minutes and at app
quit, emitting an OTLP observation log. Crash contexts include previous trials
and whether a GPU crash recurred in the current trial. `no-gpu-crash-observed`
means only that no GPU crash occurred within the recorded observation period;
it does not prove the underlying driver/Chromium fault is fixed. Abrupt termination
may lose time since the last checkpoint. This diagnostic work does not change or
pin Electron, or assert a native crash cause without a symbolicated dump.

Run `pnpm --filter polycode-electron test:crash-smoke` on a desktop with Electron
installed. It launches a hidden, isolated window with a temporary user-data folder,
forces a renderer crash, and asserts diagnostic capture, bounded breadcrumbs,
flush ordering and successful reload. Exporters and the recovery dialog are stubbed;
the renderer crash and reload use real Electron. No normal app startup or database
is loaded. The real Sentry minidump integration uses a local transport and asserts
that the native and synthetic envelopes share `crashIncidentId` and retain a full
minidump attachment. This verifies instrumentation, not the cause of Sentry POLYCODE-3A.

## Native evidence and correlation (#116)

Each exit burst receives a generated incident UUID, recorded in the immediate
local logs, OTLP crash context and synthetic Sentry event. Diagnostics must be
installed before Sentry: they stamp `polycodeIncidentId` on Electron's exit
details, which Sentry's default `SentryMinidump` integration carries into its
native event. The main-process `beforeSend` hook reads that marker and attaches
the incident's versions, lifecycle state, memory and privacy-safe activity.
Native uploads wait until the burst's collection window ends so later shutdown
signals in that window are considered; a quit after the window cannot suppress
an earlier unexpected exit. The last 20 incident records are retained in memory.

`correlationMethod: sentry-process-gone` explicitly identifies an SDK association,
not proof that every dump loaded by Sentry belongs to that particular exit.
Sentry can collect multiple pending dumps for one process-gone notification.
Dumps found on the next launch or without retained exit details are kept without
guessing a correlation or overwriting their original release. An uncorrelated
`DumpWithoutCrashing` report remains actionable evidence, regardless of its title.

Correlated native events and local `native-crash` records include a minidump UUID
when the attachment filename supplies it, and the local record also includes the
native Sentry event ID. Native exceptions, threads, module information, Crashpad
annotations, GPU adapter/driver contexts and the minidump attachment are preserved.
Renderer URLs, arbitrary exit details and SDK breadcrumbs are replaced with the
privacy-safe diagnostics. Only incidents of shutdown kills with no native exception
are eligible for native suppression, and the dump must also have a matching
Crashpad process type and a minidump header timestamp within one second of the
incident exits. Missing, stale or contradictory dump evidence stays reportable;
native exceptions and genuine crashes/OOM survive.
This filters uploads, not historical Sentry group state.

## Native symbol pipeline

The Windows release workflow downloads the **installed Electron version's**
`win32-x64-symbols.zip` from the matching Electron GitHub release and uploads its
debug information to `metroid/polycode`, waiting for Sentry processing before
publishing the installer. The existing `SENTRY_AUTH_TOKEN` repository secret must
permit debug-file uploads; a missing token or failed upload fails the release.
The build uses the same token for JavaScript source maps. Native dependencies
with their own symbols require additional matching debug files.

The client labels symbolication as `server-pending`: it cannot observe Sentry's
later processing result. For a future native occurrence, inspect the event's
Debug Images/processing issues in Sentry, retain the first minidump, and verify
module debug IDs and symbol availability against the exact Electron version,
platform and architecture. Preserve exception/thread context before resolving
the group. Uploading symbols helps future evidence; it does not establish the
cause of the historical POLYCODE-3A dump.

For downloadable raw dump evidence, Sentry's project `storeCrashReports` setting
must retain at least one report per issue. Passing the full minidump to the SDK
does not enable server retention. This repository change does not modify the
live project's retention setting; verify it during rollout using
[Sentry's project settings](https://docs.sentry.io/api/projects/retrieve-a-project/).

References: [Sentry minidump integration](https://github.com/getsentry/sentry-electron/blob/master/src/main/integrations/sentry-minidump/index.ts),
[Electron crash reporting and symbols](https://www.electronjs.org/docs/latest/tutorial/crash-reporting).
