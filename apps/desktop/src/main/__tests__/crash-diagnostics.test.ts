import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  app: Object.assign(new (class {
    handlers = new Map<string, (...args: any[]) => void>()
    on(name: string, handler: (...args: any[]) => void) { this.handlers.set(name, handler) }
  })(), {
    isReady: () => true, getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
    getVersion: () => '1', commandLine: { hasSwitch: () => false }, relaunch: vi.fn(), quit: vi.fn(),
  }),
  ipc: { on: vi.fn() }, dialog: vi.fn(), capture: vi.fn(), log: vi.fn(), flush: vi.fn(),
}))
vi.mock('electron', () => ({ app: mocks.app, ipcMain: mocks.ipc, dialog: { showMessageBox: mocks.dialog } }))
vi.mock('@sentry/electron/main', () => ({ captureEvent: mocks.capture, flush: async () => true }))
vi.mock('../app-logger', () => ({ writeFatalLog: mocks.log, flushAppLogs: mocks.flush }))
vi.mock('../observability', () => ({ recordLog: vi.fn(), flushObservability: async () => {} }))
vi.mock('../memory-telemetry', () => ({ latestMemorySamples: () => ({}) }))
import { installCrashDiagnostics, WINDOWS_SESSION_TERMINATED_EXIT_CODE } from '../crash-diagnostics'
const platform = process.platform
let beforeSend: ReturnType<typeof installCrashDiagnostics>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.app.handlers.clear()
  mocks.dialog.mockResolvedValue({ response: 1 })
  beforeSend = installCrashDiagnostics({ capture: true, locationId: () => '/private/location', incidentWindowMs: 5 })
})
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }) })
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const childGone = (details: { reason: string, exitCode: number, type: string, name?: string }) =>
  mocks.app.handlers.get('child-process-gone')!({}, details)
const windowContents = (destroyed = false) => Object.assign(new EventEmitter(), {
  id: 2, getType: () => 'window', isDestroyed: () => destroyed, reload: vi.fn(),
})
const minidumpHint = () => {
  const data = new Uint8Array(32)
  const header = new DataView(data.buffer)
  header.setUint32(0, 0x504d444d, true)
  header.setUint32(20, Math.floor(Date.now() / 1000), true)
  return { attachments: [{ attachmentType: 'event.minidump', filename: 'dump.dmp', data }] }
}

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
  expect(mocks.log).toHaveBeenCalledWith('process-gone-suppressed', expect.stringContaining('"exits":3'))
})

it('retains a genuine crash even when Windows announces shutdown', async () => {
  const window = new EventEmitter()
  mocks.app.handlers.get('browser-window-created')!({}, window)
  window.emit('query-session-end', { reasons: ['shutdown'] })
  childGone({ reason: 'crashed', exitCode: -1073741205, type: 'GPU' })
  await settle()
  expect(mocks.capture).toHaveBeenCalledOnce()
})

it('records Windows termination but retains subsequent genuine crashes', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  childGone({ reason: 'killed', exitCode: WINDOWS_SESSION_TERMINATED_EXIT_CODE, type: 'Utility' })
  childGone({ reason: 'crashed', exitCode: -1073741205, type: 'GPU' })
  childGone({ reason: 'crashed', exitCode: -1073741205, type: 'Utility' })
  await settle()
  expect(mocks.capture).toHaveBeenCalledOnce()
  expect(mocks.dialog).not.toHaveBeenCalled()
  expect(mocks.log.mock.calls.filter(([kind]) => kind === 'process-gone')).toHaveLength(3)
})

it('correlates native and synthetic events and keeps native evidence intact (#116)', async () => {
  const details = { reason: 'crashed', exitCode: 1, type: 'GPU', name: 'secret-service' }
  childGone(details)
  const native = {
    platform: 'native', event_id: 'native-event',
    contexts: { electron: { details, crashed_url: 'https://secret' }, gpu: { driver_version: '1' } },
    exception: { values: [{ type: 'native', value: 'DumpWithoutCrashing' }] },
    debug_meta: { images: [{ type: 'pe', debug_id: 'module-id' }] },
  }
  const attachment = { attachmentType: 'event.minidump', filename: '12345678-1234-1234-1234-123456789abc.dmp', data: new Uint8Array([1]) }
  const event = await beforeSend(native, { attachments: [attachment] })
  await settle()
  const synthetic = mocks.capture.mock.calls[0][0]
  expect(event?.tags?.crashIncidentId).toBe(synthetic.tags.crashIncidentId)
  expect(event?.contexts?.crash).toMatchObject({ incidentId: synthetic.tags.crashIncidentId, minidumpId: attachment.filename.slice(0, -4) })
  expect(event?.exception).toBe(native.exception)
  expect(event?.debug_meta).toBe(native.debug_meta)
  expect(event?.contexts?.gpu).toEqual({ driver_version: '1' })
  expect(JSON.stringify(event)).not.toMatch(/secret/)
  expect(attachment.data).toEqual(new Uint8Array([1]))
})

it('suppresses only correlated shutdown kills and preserves native OOM evidence', async () => {
  const details = { reason: 'killed', exitCode: 1, type: 'Utility' }
  childGone(details)
  mocks.app.handlers.get('before-quit')!({})
  const hint = minidumpHint()
  const header = new DataView(hint.attachments[0].data.buffer)
  const native = () => ({ platform: 'native', contexts: { electron: { details, 'crashpad.process_type': 'utility' } } })
  expect(await beforeSend(native(), hint)).toBeNull()
  expect(await beforeSend(native(), {})).not.toBeNull()
  header.setUint32(20, Math.floor(Date.now() / 1000) - 60, true)
  expect(await beforeSend(native(), hint)).not.toBeNull()
  header.setUint32(20, Math.floor(Date.now() / 1000), true)
  expect(await beforeSend({ platform: 'native', contexts: { electron: { details, 'crashpad.process_type': 'renderer' } } }, hint)).not.toBeNull()
  const oom = { ...native(), exception: { values: [{ type: 'OutOfMemoryError' }] } }
  expect(await beforeSend(oom, hint)).toBe(oom)
  const unmatched = { platform: 'native', release: 'polycode@old', contexts: { electron: { details: { reason: 'killed' } } } }
  expect(await beforeSend(unmatched, {})).toBe(unmatched)
  const javascript = { message: 'ordinary error' }
  expect(await beforeSend(javascript, {})).toBe(javascript)
})

it.each(['crashed', 'oom'])('retains native and synthetic %s events during shutdown', async (reason) => {
  const details = { reason, exitCode: 1, type: 'Utility' }
  childGone(details)
  mocks.app.handlers.get('before-quit')!({})
  const event = { platform: 'native', contexts: { electron: { details, 'crashpad.process_type': 'utility' } } }
  expect(await beforeSend(event, minidumpHint())).toBe(event)
  await settle()
  expect(mocks.capture).toHaveBeenCalledOnce()
})

it('does not suppress an earlier incident when shutdown starts after its collection window', async () => {
  const details = { reason: 'killed', exitCode: 1, type: 'Utility' }
  childGone(details)
  const hint = minidumpHint()
  await settle()
  const later = Date.now() + 100
  const now = vi.spyOn(Date, 'now').mockReturnValue(later)
  try {
    mocks.app.handlers.get('before-quit')!({})
    const event = { platform: 'native', contexts: { electron: { details, 'crashpad.process_type': 'utility' } } }
    expect(await beforeSend(event, hint)).toBe(event)
    expect(event.contexts.crash.shutdownSignal).toBeNull()
  } finally { now.mockRestore() }
})
