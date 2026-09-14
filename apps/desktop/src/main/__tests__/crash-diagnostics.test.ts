import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
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
import { installCrashDiagnostics } from '../crash-diagnostics'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.app.handlers.clear()
  mocks.dialog.mockResolvedValue({ response: 1 })
  installCrashDiagnostics({ capture: true, locationId: () => '/private/location' })
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
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
  const gone = mocks.app.handlers.get('child-process-gone')!
  gone({}, { reason: 'clean-exit', exitCode: 0, type: 'GPU' })
  expect(mocks.log).not.toHaveBeenCalled()
  for (let i = 0; i < 3; i++) {
    gone({}, { reason: 'crashed', exitCode: 1, type: 'GPU', name: 'secret-service' })
    await settle()
  }
  expect(mocks.capture).toHaveBeenCalledTimes(3)
  expect(mocks.dialog).toHaveBeenCalledOnce()
  expect(mocks.app.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining(['--disable-gpu']) })
  expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain('secret-service')
})
it('does not reload destroyed contents after telemetry flush', async () => {
  const contents = Object.assign(new EventEmitter(), {
    id: 2, getType: () => 'window', isDestroyed: () => true, reload: vi.fn(),
  })
  mocks.app.handlers.get('web-contents-created')!({}, contents)
  contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  await settle()
  expect(mocks.capture).toHaveBeenCalledOnce()
  expect(mocks.dialog).not.toHaveBeenCalled()
})
