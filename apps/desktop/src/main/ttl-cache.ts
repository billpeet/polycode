/**
 * Memoise an async computation per key for a fixed time. Concurrent callers share the
 * in-flight promise, so a burst of requests costs one computation. The compute function
 * should not reject: a rejection would be served from the cache for the full TTL.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value
    const value = compute()
    this.entries.set(key, { at: this.now(), value })
    return value
  }

  delete(key: string): void {
    this.entries.delete(key)
  }
}
