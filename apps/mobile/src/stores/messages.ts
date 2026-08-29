import { create } from 'zustand'
import {
  eventRole,
  foldMessages,
  type Message,
  type OutputEvent,
  type RateLimitInfo,
  type TokenUsage,
} from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

let streamCounter = 0

/**
 * Streamed frames and `messages:list` snapshots travel over independent
 * connections with no ordering between them, so the same event can arrive
 * twice: as a live frame and again inside a snapshot that was fetched while
 * that frame was still in flight. Persisted events carry their row id as
 * `eventId`, which lets us drop the replay instead of doubling the bubble.
 * Bounded per thread; fetched row ids re-seed it after each snapshot.
 */
const SEEN_EVENT_ID_LIMIT = 2000
const seenEventIdsByThread = new Map<string, Set<string>>()

function hasSeenEventId(threadId: string, eventId: string): boolean {
  return seenEventIdsByThread.get(threadId)?.has(eventId) ?? false
}

function rememberEventIds(threadId: string, eventIds: string[]): void {
  if (eventIds.length === 0) return
  let seen = seenEventIdsByThread.get(threadId)
  if (!seen) {
    seen = new Set()
    seenEventIdsByThread.set(threadId, seen)
  }
  for (const id of eventIds) {
    seen.delete(id)
    seen.add(id)
  }
  while (seen.size > SEEN_EVENT_ID_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

interface MessagesState {
  messagesByThread: Record<string, Message[]>
  usageByThread: Record<string, TokenUsage>
  rateLimitByThread: Record<string, RateLimitInfo>
  loadingByThread: Record<string, boolean>

  fetch: (threadId: string) => Promise<Message[]>
  appendEvent: (threadId: string, event: OutputEvent) => void
  appendUserMessage: (threadId: string, content: string, messageId?: string) => void
  clear: (threadId: string) => void
}

export const useMessagesStore = create<MessagesState>((set) => ({
  messagesByThread: {},
  usageByThread: {},
  rateLimitByThread: {},
  loadingByThread: {},

  fetch: async (threadId) => {
    set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: true } }))
    try {
      const messages = await rpc(requireConnection(), 'messages:list', threadId)
      // Persisted row ids are the same ids the stream frames carry, so the
      // snapshot seeds the replay guard.
      rememberEventIds(
        threadId,
        messages.map((message) => message.id),
      )
      set((s) => ({
        messagesByThread: { ...s.messagesByThread, [threadId]: messages },
        loadingByThread: { ...s.loadingByThread, [threadId]: false },
      }))
      return messages
    } catch (error) {
      set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: false } }))
      throw error
    }
  },

  appendEvent: (threadId, event) => {
    // Drop a frame that raced a snapshot refetch and was already applied.
    if (typeof event.eventId === 'string' && event.eventId) {
      if (hasSeenEventId(threadId, event.eventId)) return
      rememberEventIds(threadId, [event.eventId])
    }
    // usage events update the token counter instead of rendering a bubble.
    if (event.type === 'usage') {
      const meta = event.metadata ?? {}
      set((s) => {
        const previous = s.usageByThread[threadId]
        const input = typeof meta.input_tokens === 'number' ? meta.input_tokens : 0
        const output = typeof meta.output_tokens === 'number' ? meta.output_tokens : 0
        const total = typeof meta.total_tokens === 'number' ? meta.total_tokens : input + output
        const cost = typeof meta.cost_usd === 'number' ? meta.cost_usd : null
        const usage: TokenUsage = {
          input_tokens: (previous?.input_tokens ?? 0) + input,
          output_tokens: (previous?.output_tokens ?? 0) + output,
          total_tokens: (previous?.total_tokens ?? 0) + total,
          total_cost_usd: cost == null ? (previous?.total_cost_usd ?? null) : (previous?.total_cost_usd ?? 0) + cost,
          context_window: typeof meta.context_window === 'number' ? meta.context_window : (previous?.context_window ?? 0),
        }
        return { usageByThread: { ...s.usageByThread, [threadId]: usage } }
      })
      return
    }
    if (event.type === 'rate_limit') {
      if (event.metadata) {
        const info = event.metadata as unknown as RateLimitInfo
        set((s) => ({ rateLimitByThread: { ...s.rateLimitByThread, [threadId]: info } }))
      }
      return
    }
    // status events are not message bubbles (mirrors desktop).
    if (event.type === 'status') return
    // question / permission_request drive banner state, not bubbles.
    if (event.type === 'question' || event.type === 'permission_request') return

    const msg: Message = {
      id: `stream-${Date.now()}-${streamCounter++}`,
      thread_id: threadId,
      session_id: event.sessionId ?? null,
      role: eventRole(event),
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: foldMessages([...(s.messagesByThread[threadId] ?? []), msg]),
      },
    }))
  },

  appendUserMessage: (threadId, content, messageId) => {
    const msg: Message = {
      id: messageId ?? `optimistic-${Date.now()}-${streamCounter++}`,
      thread_id: threadId,
      session_id: null,
      role: 'user',
      content,
      metadata: null,
      created_at: new Date().toISOString(),
    }
    // The host persists this send under the same id (clientUserMessageId),
    // so remember it here too.
    rememberEventIds(threadId, [msg.id])
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...(s.messagesByThread[threadId] ?? []), msg],
      },
    }))
  },

  clear: (threadId) =>
    set((s) => {
      seenEventIdsByThread.delete(threadId)
      const updated = { ...s.messagesByThread }
      delete updated[threadId]
      return { messagesByThread: updated }
    }),
}))
