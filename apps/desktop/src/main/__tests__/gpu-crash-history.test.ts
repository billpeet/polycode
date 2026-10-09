import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GpuCrashHistory } from '../gpu-crash-history'

let directory: string
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'polycode-gpu-history-'))
  path = join(directory, 'history.json')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

it('bounds persisted launches and incidents, and expires recurrence after 30 days', () => {
  const onError = vi.fn()
  for (let i = 0; i < 25; i++) {
    const history = new GpuCrashHistory(path, false, onError)
    history.recordIncident(34, '0.14.295')
  }
  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  expect(persisted.launches).toHaveLength(20)
  expect(persisted.incidents).toHaveLength(20)
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  const expired = new GpuCrashHistory(path, false, onError)
  expect(expired.recurringAcrossLaunches()).toBe(false)
  expect(expired.context().gpuIncidentCount).toBe(0)
  expect(onError).not.toHaveBeenCalled()
})

it('keeps in-memory recurrence detection when persistence fails', () => {
  const first = new GpuCrashHistory(path, false, vi.fn())
  first.recordIncident(34, '0.14.295')
  const onError = vi.fn()
  // An existing directory blocks the atomic temporary-file write.
  mkdirSync(`${path}.tmp`)
  const next = new GpuCrashHistory(path, false, onError)
  next.recordIncident(34, '0.14.295')
  expect(next.recurringAcrossLaunches()).toBe(true)
  expect(next.context().gpuIncidentCount).toBe(2)
  expect(onError).toHaveBeenCalled()
})
