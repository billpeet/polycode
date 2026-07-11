/**
 * Event router for the remote SSE stream. The stream is global (no subscribe
 * handshake); consumers register exact-channel or channel-prefix listeners
 * and the router dispatches each incoming {channel, args} frame.
 */

export type EventListener = (channel: string, ...args: unknown[]) => void

interface PrefixSubscription {
  prefix: string
  listener: EventListener
}

const exactListeners = new Map<string, Set<EventListener>>()
const prefixListeners = new Set<PrefixSubscription>()

/** Subscribe to one exact channel (e.g. `thread:output:<id>`). Returns unsubscribe. */
export function onChannel(channel: string, listener: EventListener): () => void {
  let set = exactListeners.get(channel)
  if (!set) {
    set = new Set()
    exactListeners.set(channel, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) exactListeners.delete(channel)
  }
}

/** Subscribe to every channel starting with a prefix (e.g. `thread:status:`). Returns unsubscribe. */
export function onChannelPrefix(prefix: string, listener: EventListener): () => void {
  const sub: PrefixSubscription = { prefix, listener }
  prefixListeners.add(sub)
  return () => {
    prefixListeners.delete(sub)
  }
}

/** Dispatch an incoming stream event to all matching listeners. */
export function dispatchEvent(channel: string, args: unknown[]): void {
  const exact = exactListeners.get(channel)
  if (exact) {
    for (const listener of [...exact]) {
      try {
        listener(channel, ...args)
      } catch (error) {
        console.warn('[events] listener error on', channel, error)
      }
    }
  }
  for (const sub of [...prefixListeners]) {
    if (channel.startsWith(sub.prefix)) {
      try {
        sub.listener(channel, ...args)
      } catch (error) {
        console.warn('[events] prefix listener error on', channel, error)
      }
    }
  }
}

// ── Channel name builders (mirror desktop emitAppEvent channels) ────────────

export const channels = {
  threadOutput: (threadId: string) => `thread:output:${threadId}`,
  threadStatus: (threadId: string) => `thread:status:${threadId}`,
  threadComplete: (threadId: string) => `thread:complete:${threadId}`,
  threadTitle: (threadId: string) => `thread:title:${threadId}`,
  threadPid: (threadId: string) => `thread:pid:${threadId}`,
  threadSessionSwitched: (threadId: string) => `thread:session-switched:${threadId}`,
} as const

export const channelPrefixes = {
  threadStatus: 'thread:status:',
  threadTitle: 'thread:title:',
  threadComplete: 'thread:complete:',
} as const

/** Extract the trailing thread id from a templated channel name given its prefix. */
export function channelSuffix(channel: string, prefix: string): string {
  return channel.slice(prefix.length)
}
