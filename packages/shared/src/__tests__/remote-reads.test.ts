import { afterEach, expect, it, vi } from 'vitest'
import { isRemoteHostBusyError, isRemoteHostBusyResponse, RemoteHostBusyError, RemoteReads } from '../remote-reads'

afterEach(() => vi.useRealTimers())

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

it('admits at most six calls across all channels, ahead of queued refreshes', async () => {
  const reads = new RemoteReads()
  const started: string[] = []
  const release = new Map<string, () => void>()
  const op = (name: string) => () => new Promise<void>((resolve) => {
    started.push(name)
    release.set(name, resolve)
  })
  const requests = [
    ...Array.from({ length: 6 }, (_, i) => reads.invoke('threads:list', [i], op(`refresh${i}`))),
    ...Array.from({ length: 4 }, (_, i) => reads.invoke('locations:list', [i], op(`call${i}`))),
  ]
  expect(started).toEqual(['refresh0', 'refresh1', 'refresh2', 'refresh3', 'call0', 'call1'])

  release.get('refresh0')!()
  await flush()
  expect(started.at(-1)).toBe('call2')
  release.get('refresh1')!()
  await flush()
  expect(started.at(-1)).toBe('call3')
  release.get('refresh2')!()
  await flush()
  expect(started.at(-1)).toBe('refresh4')
  expect(started).toHaveLength(9)

  while (started.length < 10) {
    for (const resolve of release.values()) resolve()
    await flush()
  }
  for (const resolve of release.values()) resolve()
  await expect(Promise.all(requests)).resolves.toHaveLength(10)
})

it.each(['threads:list', 'threads:create'])('retries %s while the host refuses it unstarted', async (channel) => {
  vi.useFakeTimers()
  const operation = vi.fn()
    .mockRejectedValueOnce(new RemoteHostBusyError())
    .mockRejectedValueOnce(new RemoteHostBusyError())
    .mockResolvedValue('ok')
  const result = new RemoteReads().invoke(channel, [], operation)
  await vi.advanceTimersByTimeAsync(2_000)
  await expect(result).resolves.toBe('ok')
  expect(operation).toHaveBeenCalledTimes(3)
})

it('does not retry other failures', async () => {
  const operation = vi.fn().mockRejectedValue(new Error('[REMOTE_REQUEST_TIMEOUT] may have completed'))
  await expect(new RemoteReads().invoke('threads:create', [], operation)).rejects.toThrow('may have completed')
  expect(operation).toHaveBeenCalledTimes(1)
})

it('gives up after three retries without treating refusals as a host stall', async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const reads = new RemoteReads(changed)
  const refused = vi.fn(async () => { throw new RemoteHostBusyError() })
  const outcomes = Promise.allSettled([0, 1, 2].map((i) => reads.invoke('threads:list', [i], refused)))
  await vi.advanceTimersByTimeAsync(5_000)
  const results = await outcomes
  expect(results.every((result) => result.status === 'rejected' && isRemoteHostBusyError(result.reason))).toBe(true)
  expect(refused).toHaveBeenCalledTimes(12)
  expect(changed).not.toHaveBeenCalled()
  // Not deferred by a stall cooldown: the next refresh goes straight to the host.
  await expect(reads.invoke('threads:list', ['next'], async () => [])).resolves.toEqual([])
})

it('recognises a refusal from current and older hosts, and nothing else', () => {
  const legacy = '[REMOTE_REQUEST_TIMEOUT] Remote host is busy. This request was not started; retry shortly.'
  expect(isRemoteHostBusyResponse(503, { code: 'REMOTE_HOST_BUSY', error: legacy })).toBe(true)
  expect(isRemoteHostBusyResponse(503, { error: legacy })).toBe(true)
  expect(isRemoteHostBusyResponse(500, { error: legacy })).toBe(false)
  expect(isRemoteHostBusyResponse(503, { error: 'Service Unavailable' })).toBe(false)
  // The renderer only sees the message across Electron IPC; it must stay a transport error.
  expect(new RemoteHostBusyError().message).toContain('[REMOTE_REQUEST_TIMEOUT]')
})

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
