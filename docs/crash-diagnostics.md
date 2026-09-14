# Native process crash diagnostics

Unexpected renderer and child-process exits produce a fatal local log and OTLP log,
and a Sentry event in production. Clean exits are ignored. Reports include the exit
reason and code, process category, versions, GPU status, latest memory samples with
timestamps, last reported workspace view category, and up to 40 recent IPC/stall
breadcrumbs. A sample may predate a crash by 30 seconds or more. The view is the
last selected workspace category, not a record of keyboard focus.

Webview reports use a SHA-256 hash of the Project Location ID. Reports omit page
URLs, paths, IPC arguments, and arbitrary child service names. Child processes use
the Electron process type as their diagnostic name. Local logs flush immediately;
Sentry and OTLP get up to two seconds before recovery is presented.

Renderer recovery reloads the affected webContents, including a guest when only a
browser tab fails. After three unexpected exits within five minutes in the same
app run, recovery also offers a restart with GPU disabled. Restart stops running
sessions. The diagnostic launch option is `PolyCode.exe --disable-gpu`; closing
that instance and launching normally restores the usual graphics configuration.

Run `pnpm --filter polycode-electron test:crash-smoke` on a desktop with Electron
installed. It launches a hidden, isolated window with a temporary user-data folder,
forces a renderer crash, and asserts diagnostic capture, bounded breadcrumbs,
flush ordering and successful reload. Exporters and the recovery dialog are stubbed;
the renderer crash and reload use real Electron. No normal app startup or database
is loaded. This verifies instrumentation, not the cause of Sentry POLYCODE-3A.
