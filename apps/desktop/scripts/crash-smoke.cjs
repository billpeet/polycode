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
let logged, captured, flushed = false, prompts = 0
Module._load = function (id, ...args) {
  if (id === './app-logger') return {
    writeFatalLog: (kind, value) => { assert.equal(kind, 'process-gone'); logged = JSON.parse(value) },
    flushAppLogs: () => {},
  }
  if (id === './observability') return { recordLog: () => {}, flushObservability: async () => { flushed = true } }
  if (id === './memory-telemetry') return { latestMemorySamples: () => ({ main: { heapUsedBytes: 123, sampledAt: Date.now() } }) }
  if (id === '@sentry/electron/main') return { captureEvent: (event) => { captured = event }, flush: async () => true }
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
require('../src/main/crash-diagnostics.ts').installCrashDiagnostics({ capture: true, locationId: () => undefined })
const { recordCrashBreadcrumb } = require('../src/main/crash-context.ts')
for (let i = 0; i < 50; i++) recordCrashBreadcrumb('ipc.start.threads:list')
const timeout = setTimeout(() => { console.error('Crash smoke timed out'); app.exit(1) }, 20000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('data:text/html,<h1>Isolated crash smoke</h1>')
  win.webContents.once('did-finish-load', () => {
    try {
      assert.equal(logged.reason, 'crashed')
      assert.equal(logged.processType, 'main-renderer')
      assert.equal(logged.breadcrumbs.length, 40)
      assert.equal(logged.memory.main.heapUsedBytes, 123)
      assert.ok(logged.electronVersion)
      assert.equal(captured.level, 'fatal')
      assert.equal(prompts, 1)
      assert.ok(!JSON.stringify(logged).includes('data:text'))
      console.log('PASS: real renderer crash captured, flushed and reloaded')
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
