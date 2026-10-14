import { expect, it, vi } from 'vitest'
import { TtlCache } from '../ttl-cache'

it('shares in-flight work, serves hits within the TTL, and recomputes after expiry or delete', async () => {
  let now = 0
  const cache = new TtlCache<number>(30_000, () => now)
  let release!: (n: number) => void
  const compute = vi.fn(() => new Promise<number>((resolve) => { release = resolve }))

  const a = cache.get('repo', compute)
  const b = cache.get('repo', compute)
  expect(compute).toHaveBeenCalledTimes(1)
  release(1)
  expect(await a).toBe(1)
  expect(await b).toBe(1)

  now = 29_999
  expect(await cache.get('repo', async () => 2)).toBe(1)
  now = 30_000
  expect(await cache.get('repo', async () => 3)).toBe(3)

  cache.delete('repo')
  expect(await cache.get('repo', async () => 4)).toBe(4)
  expect(await cache.get('other', async () => 5)).toBe(5)
})
