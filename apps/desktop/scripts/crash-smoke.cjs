// Isolated Electron process: no application database, network exporters or normal startup.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const Module = require('node:module')
const ts = require('typescript')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polycode-crash-smoke-'))
app.setPath('userData', dataDir)
app.disableHardwareAcceleration()
const originalLoad = Module._load
let logged, captured, native, nativeAttachment, flushed = false, prompts = 0
Module._load = function (id, ...args) {
  if (id === './app-logger') return {
    writeFatalLog: (kind, value) => {
      assert.ok(['process-gone', 'process-gone-incident', 'native-crash'].includes(kind))
      if (kind !== 'native-crash') logged = JSON.parse(value)
    },
    flushAppLogs: () => {},
  }
  if (id === './observability') return { recordLog: () => {}, flushObservability: async () => { flushed = true } }
  if (id === './memory-telemetry') return { latestMemorySamples: () => ({ main: { heapUsedBytes: 123, sampledAt: Date.now() } }) }
  return originalLoad.call(this, id, ...args)
}
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename)
}
dialog.showMessageBox = async () => {
  assert.ok(flushed, 'flush precedes recovery')
  prompts++
  return { response: 0 }
}
const beforeSend = require('../src/main/crash-diagnostics.ts').installCrashDiagnostics({ capture: true, locationId: () => undefined })
const Sentry = require('@sentry/electron/main')
// Exercise the real native uploader and beforeSend hook. The transport collects
// envelopes locally: no exporter can send this deliberate crash to production.
Sentry.init({
  dsn: 'https://smoke@example.invalid/1',
  release: 'polycode@crash-smoke',
  defaultIntegrations: false,
  integrations: [Sentry.sentryMinidumpIntegration()],
  beforeSend,
  transport: () => ({
    send: async ([, items]) => {
      for (const [headers, payload] of items) {
        if (headers.type === 'event') {
          if (payload.platform === 'native') native = payload
          else captured = payload
        }
        if (headers.type === 'attachment' && headers.attachment_type === 'event.minidump') nativeAttachment = payload
      }
      return { statusCode: 200 }
    },
    flush: async () => true,
  }),
})
const { recordCrashBreadcrumb } = require('../src/main/crash-context.ts')
for (let i = 0; i < 50; i++) recordCrashBreadcrumb('ipc.start.threads:list')
const timeout = setTimeout(() => { console.error('Crash smoke timed out'); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('data:text/html,<h1>Isolated crash smoke</h1>')
  win.webContents.once('did-finish-load', async () => {
    try {
      // The minidump loader waits for Crashpad to finish writing the file.
      const deadline = Date.now() + 8000
      while (!native && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(logged.reason, 'crashed')
      assert.equal(logged.processType, 'main-renderer')
      assert.equal(logged.breadcrumbs.length, 40)
      assert.equal(logged.memory.main.heapUsedBytes, 123)
      assert.ok(logged.electronVersion)
      assert.equal(captured.level, 'fatal')
      assert.ok(native, 'real minidump event reached the local transport')
      assert.ok(nativeAttachment?.length, 'full minidump attachment is preserved')
      assert.equal(native.tags.crashIncidentId, captured.tags.crashIncidentId)
      assert.equal(native.contexts.crash.incidentId, logged.incidentId)
      assert.ok(native.contexts.crash.minidumpId)
      // Electron can deliver an exit more than a second after the dump. The
      // conservative suppression check may decline that timestamp match;
      // incident IDs and the full dump must survive either way.
      assert.equal(prompts, 1)
      assert.ok(!JSON.stringify(logged).includes('data:text'))
      console.log('PASS: real native and synthetic crash events share an incident ID; minidump preserved, renderer reloaded')
      clearTimeout(timeout)
      win.destroy()
      app.quit()
    } catch (error) { console.error(error); app.exit(1) }
  })
  win.webContents.forcefullyCrashRenderer()
}).catch((error) => { console.error(error); app.exit(1) })
app.on('will-quit', () => {
  // Only remove the exact isolated directory created by this test.
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* Windows may retain crash files until exit. */ }
})
