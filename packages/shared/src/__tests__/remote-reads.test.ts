import { afterEach, expect, it, vi } from 'vitest'
import { RemoteReads } from '../remote-reads'

afterEach(() => vi.useRealTimers())

it('coalesces duplicate reads, bounds concurrency, pauses after timeouts, and probes recovery', async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const reads = new RemoteReads(changed)
  const operation = vi.fn(() => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('REMOTE_REQUEST_TIMEOUT')), 10_000)
  }))
  const first = reads.invoke('threads:list', ['0'], operation)
  expect(reads.invoke('threads:list', ['0'], operation)).toBe(first)
  const outcomes = Promise.allSettled([first, ...Array.from({ length: 20 }, (_, i) =>
    reads.invoke('threads:list', [String(i + 1)], operation))])
  expect(operation).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(20_000)
  expect((await outcomes).every((result) => result.status === 'rejected')).toBe(true)
  expect(operation.mock.calls.length).toBeLessThanOrEqual(6)
  expect(changed.mock.calls).toEqual([[true]])
  await expect(reads.invoke('sessions:list', ['t'], operation)).rejects.toThrow('REMOTE_REQUEST_TIMEOUT')
  const mutation = vi.fn(async () => 'sent')
  await expect(reads.invoke('threads:send', ['t'], mutation)).resolves.toBe('sent')
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(reads.invoke('sessions:list', ['t'], async () => [])).resolves.toEqual([])
  expect(changed.mock.calls).toEqual([[true], [false]])
})

it('does not treat unexpected errors or isolated timeouts as a host stall', async () => {
  const changed = vi.fn()
  const reads = new RemoteReads(changed)
  for (const message of ['SQLITE_CORRUPT', 'REMOTE_REQUEST_TIMEOUT']) {
    await expect(reads.invoke('threads:list', [], async () => { throw new Error(message) })).rejects.toThrow(message)
  }
  expect(changed).not.toHaveBeenCalled()
  await expect(reads.invoke('threads:list', [], async () => [])).resolves.toEqual([])
})

it('discards queued work when the connection changes', async () => {
  const reads = new RemoteReads()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const operation = vi.fn(() => blocked)
  const requests = Array.from({ length: 8 }, (_, i) => reads.invoke('threads:list', [i], operation))
  const outcomes = Promise.allSettled(requests)
  reads.dispose()
  release()
  expect((await outcomes).filter((result) => result.status === 'rejected')).toHaveLength(4)
  expect(operation).toHaveBeenCalledTimes(4)
})
