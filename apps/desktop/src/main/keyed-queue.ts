const tails = new Map<string, Promise<unknown>>()

/**
 * Run `operation` after every earlier operation queued under the same `key` has settled.
 *
 * Worktree add/remove share one git repository (and its index lock): Grafana showed three
 * removals launched together taking 71s / 65s / 3.9s because they serialised on git's
 * `index.lock` retries rather than on us. Queueing per parent repository makes the second
 * one wait for free instead of spinning, and keeps `git worktree prune` from racing an add.
 */
export function runSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const settled = run.then(() => undefined, () => undefined)
  tails.set(key, settled)
  void settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key)
  })
  return run
}
