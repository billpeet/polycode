import { describe, expect, it } from 'vitest'
import { runSerialized } from '../keyed-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('runSerialized', () => {
  it('runs operations under the same key one after another, in order', async () => {
    const order: string[] = []
    const first = deferred<void>()
    const a = runSerialized('repo', async () => { order.push('a:start'); await first.promise; order.push('a:end') })
    const b = runSerialized('repo', async () => { order.push('b:start') })
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('does not block a different key', async () => {
    const gate = deferred<void>()
    void runSerialized('repo-1', () => gate.promise)
    const other = runSerialized('repo-2', async () => 'ran')
    await expect(other).resolves.toBe('ran')
    gate.resolve()
  })

  it('a failure neither blocks nor fails the next operation', async () => {
    const failing = runSerialized('repo', async () => { throw new Error('boom') })
    const next = runSerialized('repo', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
  })
})
