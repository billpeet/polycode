import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  app: Object.assign(new (class {
    handlers = new Map<string, (...args: any[]) => void>()
    on(name: string, handler: (...args: any[]) => void) { this.handlers.set(name, handler) }
  })(), {
    isReady: () => true, getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
    getVersion: () => '1', commandLine: { hasSwitch: () => false }, relaunch: vi.fn(), quit: vi.fn(),
    whenReady: async () => {}, getGPUInfo: vi.fn(),
  }),
  report: vi.fn(),
  ipc: { on: vi.fn() }, dialog: vi.fn(), capture: vi.fn(), log: vi.fn(), flush: vi.fn(),
}))
vi.mock('electron', () => ({ app: mocks.app, crashReporter: { getLastCrashReport: mocks.report }, ipcMain: mocks.ipc, dialog: { showMessageBox: mocks.dialog } }))
vi.mock('@sentry/electron/main', () => ({ captureEvent: mocks.capture, flush: async () => true }))
vi.mock('../app-logger', () => ({ writeFatalLog: mocks.log, flushAppLogs: mocks.flush }))
vi.mock('../observability', () => ({ recordLog: vi.fn(), flushObservability: async () => {} }))
vi.mock('../memory-telemetry', () => ({ latestMemorySamples: () => ({}) }))
import { installCrashDiagnostics, WINDOWS_SESSION_TERMINATED_EXIT_CODE } from '../crash-diagnostics'
const platform = process.platform
let directory: string
let historyPath: string
function install() {
  installCrashDiagnostics({ capture: true, locationId: () => '/private/location', incidentWindowMs: 5, historyPath })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.app.handlers.clear()
  mocks.dialog.mockResolvedValue({ response: 1 })
  mocks.app.commandLine.hasSwitch = () => false
  mocks.app.getGPUInfo.mockResolvedValue({ gpuDevice: [{ vendorId: 4318, deviceId: 123, driverVersion: '32.0.15', deviceString: 'secret-device' }], auxAttributes: { softwareRendering: false, secret: '/private/path' } })
  mocks.report.mockReturnValue(null)
  directory = mkdtempSync(join(tmpdir(), 'polycode-crash-test-'))
  historyPath = join(directory, 'history.json')
  install()
})
afterEach(() => {
  mocks.app.handlers.get('before-quit')!({})
  Object.defineProperty(process, 'platform', { value: platform })
  rmSync(directory, { recursive: true, force: true })
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const childGone = (details: { reason: string, exitCode: number, type: string, name?: string }) =>
  mocks.app.handlers.get('child-process-gone')!({}, details)
const windowContents = (destroyed = false) => Object.assign(new EventEmitter(), {
  id: 2, getType: () => 'window', isDestroyed: () => destroyed, reload: vi.fn(),
})

it('hashes guest locations, drops arbitrary detail fields and reloads the guest', async () => {
  const guest = Object.assign(new EventEmitter(), {
    id: 1, getType: () => 'webview', isDestroyed: () => false, reload: vi.fn(),
  })
  mocks.dialog.mockResolvedValue({ response: 0 })
  mocks.app.handlers.get('web-contents-created')!({}, guest)
  guest.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1, url: 'https://secret' })
  await settle()
  const event = mocks.capture.mock.calls[0][0]
  expect(event.contexts.crash.processType).toBe('webview')
  expect(event.contexts.crash.guestLocationId).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(event)).not.toMatch(/private|secret/)
  expect(guest.reload).toHaveBeenCalledOnce()
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.dialog.mock.invocationCallOrder[0])
})

it('ignores clean exits and offers GPU restart after repeated child failures', async () => {
  childGone({ reason: 'clean-exit', exitCode: 0, type: 'GPU' })
  expect(mocks.log).not.toHaveBeenCalled()
  for (let i = 0; i < 3; i++) {
    childGone({ reason: 'crashed', exitCode: 1, type: 'GPU', name: 'secret-service' })
    await settle()
  }
  expect(mocks.capture).toHaveBeenCalledTimes(3)
  expect(mocks.dialog).toHaveBeenCalledOnce()
  expect(mocks.app.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining(['--disable-gpu']) })
  expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain('secret-service')
})

it('does not reload destroyed contents after telemetry flush', async () => {
  const contents = windowContents(true)
  mocks.app.handlers.get('web-contents-created')!({}, contents)
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  await settle()
  expect(mocks.capture).toHaveBeenCalledOnce()
  expect(mocks.dialog).not.toHaveBeenCalled()
})

it('reports a burst of GPU and Utility crashes as one incident', async () => {
  for (let i = 0; i < 4; i++) {
    childGone({ reason: 'crashed', exitCode: -1073741205, type: 'GPU' })
    childGone({ reason: 'crashed', exitCode: -1073741205, type: 'Utility' })
  }
  await settle()
  expect(mocks.log.mock.calls.filter(([kind]) => kind === 'process-gone')).toHaveLength(8)
  expect(mocks.capture).toHaveBeenCalledOnce()
  const event = mocks.capture.mock.calls[0][0]
  expect(event.level).toBe('fatal')
  expect(event.fingerprint).toEqual(['process-gone', 'GPU', 'crashed', '-1073741205'])
  expect(event.tags).toMatchObject({ processType: 'GPU', reason: 'crashed', exitCode: '-1073741205', exitCount: '8' })
  expect(event.contexts.crash.exits.map((exit: { processType: string }) => exit.processType))
    .toEqual(['GPU', 'Utility', 'GPU', 'Utility', 'GPU', 'Utility', 'GPU', 'Utility'])
  expect(mocks.dialog).not.toHaveBeenCalled()
})

it('reports a crash, not the kills around it, as the incident trigger', async () => {
  childGone({ reason: 'killed', exitCode: 1, type: 'Utility' })
  childGone({ reason: 'crashed', exitCode: 5, type: 'GPU' })
  await settle()
  expect(mocks.capture.mock.calls[0][0]).toMatchObject({ level: 'fatal', tags: { processType: 'GPU', reason: 'crashed' } })
})

it('keeps isolated kills outside shutdown observable at warning level', async () => {
  childGone({ reason: 'killed', exitCode: 1, type: 'Utility' })
  await settle()
  expect(mocks.capture.mock.calls[0][0]).toMatchObject({ level: 'warning', tags: { reason: 'killed' } })
})

it('reports nothing when processes are torn down while the app quits (#96)', async () => {
  const contents = windowContents()
  mocks.app.handlers.get('web-contents-created')!({}, contents)
  // The updater closes windows before `before-quit`, so exits can precede the signal.
  contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 })
  mocks.app.handlers.get('before-quit')!({})
  childGone({ reason: 'killed', exitCode: 1, type: 'GPU' })
  childGone({ reason: 'killed', exitCode: 1, type: 'Utility' })
  await settle()
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(mocks.dialog).not.toHaveBeenCalled()
  expect(contents.reload).not.toHaveBeenCalled()
  expect(mocks.log).toHaveBeenCalledWith('process-gone-suppressed', expect.stringContaining('"exits":1'))
})

it('reports nothing once Windows announces the session is ending (#97)', async () => {
  const window = new EventEmitter()
  mocks.app.handlers.get('browser-window-created')!({}, window)
  window.emit('query-session-end', { reasons: ['shutdown'] })
  childGone({ reason: 'crashed', exitCode: -1073741205, type: 'GPU' })
  await settle()
  expect(mocks.capture).not.toHaveBeenCalled()
})

it('treats a Windows session-termination kill as shutdown when no session-end event arrived (#97)', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  childGone({ reason: 'killed', exitCode: WINDOWS_SESSION_TERMINATED_EXIT_CODE, type: 'Utility' })
  childGone({ reason: 'crashed', exitCode: -1073741205, type: 'GPU' })
  childGone({ reason: 'crashed', exitCode: -1073741205, type: 'Utility' })
  await settle()
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(mocks.dialog).not.toHaveBeenCalled()
  expect(mocks.log.mock.calls.filter(([kind]) => kind === 'process-gone')).toHaveLength(3)
})

it('captures allowlisted GPU metadata and recent workspace activity for a GPU child', async () => {
  await settle()
  const handler = mocks.ipc.on.mock.calls.find(([name]) => name === 'telemetry:view')![1]
  handler({ sender: windowContents() }, 'diff')
  handler({ sender: windowContents() }, 'https://secret')
  mocks.report.mockReturnValue({ id: 'abc-123', date: new Date(1000) })
  childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
  await settle()
  const context = mocks.capture.mock.calls[0][0].contexts.crash
  expect(context.gpuInfo.devices).toEqual([{ vendorId: 4318, deviceId: 123, driverVersion: '32.0.15' }])
  expect(context.activeView).toBe('diff')
  expect(context.recentViews).toEqual([{ at: expect.any(Number), view: 'diff' }])
  expect(context.latestUploadedReport).toEqual({ id: 'abc-123', at: 1000, correlatedToIncident: false })
  expect(JSON.stringify(context)).not.toMatch(/secret|private/)
})

it('offers GPU recovery on the second launch with a GPU crash, counting bursts once', async () => {
  childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
  childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
  await settle()
  expect(mocks.dialog).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(historyPath, 'utf8')).incidents).toHaveLength(1)
  install()
  mocks.dialog.mockResolvedValue({ response: 1 })
  childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
  await settle()
  expect(mocks.dialog).toHaveBeenCalledOnce()
  expect(mocks.dialog.mock.calls[0][0].detail).toContain('across app launches')
  expect(mocks.app.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining(['--disable-gpu']) })
  expect(mocks.capture.mock.calls[1][0].contexts.crash.gpuHistory.priorLaunchGpuIncidentCount).toBe(1)
})

it('does not persist shutdown exits or offer GPU recovery for a Utility-only recurrence', async () => {
  childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
  mocks.app.handlers.get('before-quit')!({})
  await settle()
  expect(JSON.parse(readFileSync(historyPath, 'utf8')).incidents).toHaveLength(0)
  install()
  childGone({ reason: 'crashed', exitCode: 1, type: 'Utility' })
  await settle()
  install()
  childGone({ reason: 'crashed', exitCode: 1, type: 'Utility' })
  await settle()
  expect(mocks.dialog).not.toHaveBeenCalled()
})

it('records observed GPU-disabled recovery time and distinguishes recurrence', async () => {
  mocks.app.commandLine.hasSwitch = () => true
  install()
  await settle()
  mocks.app.handlers.get('before-quit')!({})
  let launch = JSON.parse(readFileSync(historyPath, 'utf8')).launches.at(-1)
  expect(launch).toMatchObject({ disableGpu: true, gpuIncidents: 0 })
  expect(launch.observedMs).toBeGreaterThan(0)
  install()
  for (let i = 0; i < 3; i++) {
    childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
    await settle()
  }
  expect(mocks.dialog.mock.calls[0][0].buttons).not.toContain('Restart with GPU disabled')
  expect(mocks.capture.mock.calls[0][0].contexts.crash.gpuHistory).toMatchObject({
    recovery: { outcome: 'gpu-crash-recurred', gpuIncidents: 1 },
    previousGpuDisabledLaunches: [{ at: expect.any(Number), observedMs: expect.any(Number), gpuIncidents: 0 }],
  })
  launch = JSON.parse(readFileSync(historyPath, 'utf8')).launches.at(-1)
  expect(launch.gpuIncidents).toBe(3)
})

it('keeps diagnostics and recovery working with corrupt history and unavailable GPU/report APIs', async () => {
  writeFileSync(historyPath, '{bad json')
  mocks.app.getGPUInfo.mockRejectedValue(new Error('unavailable'))
  mocks.report.mockImplementation(() => { throw new Error('unavailable') })
  install()
  childGone({ reason: 'crashed', exitCode: 34, type: 'GPU' })
  await settle()
  expect(mocks.capture.mock.calls[0][0].contexts.crash).toMatchObject({ gpuInfo: null, latestUploadedReport: null })
  expect(JSON.parse(readFileSync(historyPath, 'utf8')).incidents).toHaveLength(1)
})
