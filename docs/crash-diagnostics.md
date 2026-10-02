# Native process crash diagnostics

Unexpected renderer and child-process exits produce a fatal local log and OTLP log,
and a Sentry event in production. Clean exits are ignored. Reports include the exit
reason and code, process category, versions, GPU status, latest memory samples with
timestamps, last reported workspace view category, and up to 40 recent IPC/stall
breadcrumbs. A sample may predate a crash by 30 seconds or more. The view is the
last selected workspace category, not a record of keyboard focus.

Electron reports each affected process separately, so exits that arrive within
1.5 seconds of the first are one incident: one Sentry event and one OTLP log,
fingerprinted by the triggering process type, reason and exit code, with every
exit listed in the context. The trigger is the first exit that was not merely
`killed`. An incident of kills alone is reported as a warning, not a fatal. The
local log still records every exit as it happens, because the main process may
not outlive the burst.

Exits during shutdown are logged locally and not reported. Shutdown starts at
`before-quit`, which covers closing the app, installing an update and the GPU
diagnostic relaunch. On Windows, `before-quit` is not emitted when the machine
shuts down, restarts or logs off, so a window's `query-session-end` or
`session-end` event also counts, as does a process killed with exit code
`0x40010004`, which Windows uses for processes it terminates while ending the
session. A Windows signal suppresses reports for 60 seconds, because a shutdown
can still be cancelled. Signals that arrive during an incident's 1.5 seconds
suppress the whole incident. In GitHub #97, a Windows Update restart killed
PolyCode's processes, Chromium's relaunches failed, and Chromium ended the app
with "GPU process isn't usable. Goodbye."; that produced about 21 fatal events
and a native minidump with no defect behind them.

Webview reports use a SHA-256 hash of the Project Location ID. Reports omit page
URLs, paths, IPC arguments, and arbitrary child service names. Child processes use
the Electron process type as their diagnostic name. Local logs flush immediately;
Sentry and OTLP get up to two seconds before recovery is presented.

Renderer recovery reloads the affected webContents, including a guest when only a
browser tab fails. After three incidents within five minutes in the same app run,
recovery also offers a restart with GPU disabled. Restart stops running
sessions. The diagnostic launch option is `PolyCode.exe --disable-gpu`; closing
that instance and launching normally restores the usual graphics configuration.

Run `pnpm --filter polycode-electron test:crash-smoke` on a desktop with Electron
installed. It launches a hidden, isolated window with a temporary user-data folder,
forces a renderer crash, and asserts diagnostic capture, bounded breadcrumbs,
flush ordering and successful reload. Exporters and the recovery dialog are stubbed;
the renderer crash and reload use real Electron. No normal app startup or database
is loaded. This verifies instrumentation, not the cause of Sentry POLYCODE-3A.
