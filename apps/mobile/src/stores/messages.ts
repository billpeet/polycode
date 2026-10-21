import { create } from 'zustand'
import {
  eventRole,
  appendFoldedMessage,
  applyMessagePage,
  EMPTY_TRANSCRIPT_WINDOW,
  isUnsupportedChannelError,
  pageFromFullTranscript,
  refreshRequest,
  sendsToConfirm,
  type Message,
  type MessagePage,
  type MessagePageRequest,
  type OutputEvent,
  type RateLimitInfo,
  type TokenUsage,
  type TranscriptWindow,
} from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

let streamCounter = 0

/**
 * One page from the host. A host older than `messages:page` answers with its whole
 * transcript instead, which then never has older pages to load.
 */
async function requestPage(threadId: string, request: MessagePageRequest): Promise<MessagePage> {
  const connection = requireConnection()
  try {
    return await rpc(connection, 'messages:page', { threadId }, request)
  } catch (error) {
    if (!isUnsupportedChannelError(error)) throw error
    if (request.kind === 'older') return { messages: [], hasOlder: false, anchored: true }
    return pageFromFullTranscript(await rpc(connection, 'messages:list', threadId))
  }
}

/** What is known about the part of a transcript held in `messagesByThread`. */
export interface TranscriptPaging {
  /** More messages exist before the first one held. */
  hasOlder: boolean
  /** Anchor for the next `older` request. */
  oldestId: string | null
  /** Anchor for the next `since` request. */
  newestPersistedId: string | null
}

/**
 * Streamed frames and `messages:page` snapshots travel over independent
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
  pagingByThread: Record<string, TranscriptPaging>
  loadingOlderByThread: Record<string, boolean>

  /**
   * Bring the held transcript up to date: the newest page on first load, then only
   * what changed since. Resolves with the page, whose `todos` cover the whole thread.
   */
  fetch: (threadId: string) => Promise<MessagePage>
  /** Prepend the page before the oldest message held, if there is one. */
  fetchOlder: (threadId: string) => Promise<void>
  /** Replace a page's trimmed copy of `message` (`omitted_chars`) with the whole message. */
  expandMessage: (message: Message) => Promise<void>
  appendEvent: (threadId: string, event: OutputEvent) => void
  appendUserMessage: (threadId: string, content: string, messageId?: string) => void
  clear: (threadId: string) => void
}

function heldWindow(s: MessagesState, threadId: string): TranscriptWindow | undefined {
  const messages = s.messagesByThread[threadId]
  const paging = s.pagingByThread[threadId]
  return messages || paging ? { ...EMPTY_TRANSCRIPT_WINDOW, ...paging, messages: messages ?? [] } : undefined
}

/** The ids among `sends` the host holds. A send the host can't vouch for stays held. */
async function persistedSends(threadId: string, sends: Message[]): Promise<Set<string>> {
  const found = await Promise.all(sends.map(async (message) => {
    try {
      return (await rpc(requireConnection(), 'messages:full', { threadId }, message.id)) ? message.id : null
    } catch {
      return null
    }
  }))
  return new Set(found.filter((messageId): messageId is string => messageId !== null))
}

function applyPage(
  s: MessagesState,
  threadId: string,
  request: MessagePageRequest,
  page: MessagePage,
  persisted?: ReadonlySet<string>,
): Partial<MessagesState> {
  const next = applyMessagePage(heldWindow(s, threadId), request, page, persisted)
  return {
    messagesByThread: { ...s.messagesByThread, [threadId]: next.messages },
    pagingByThread: {
      ...s.pagingByThread,
      [threadId]: { hasOlder: next.hasOlder, oldestId: next.oldestId, newestPersistedId: next.newestPersistedId },
    },
  }
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messagesByThread: {},
  usageByThread: {},
  rateLimitByThread: {},
  loadingByThread: {},
  pagingByThread: {},
  loadingOlderByThread: {},

  fetch: async (threadId) => {
    set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: true } }))
    try {
      const state = get()
      const paging = state.pagingByThread[threadId]
      const request = refreshRequest(paging ? { messages: state.messagesByThread[threadId] ?? [], ...paging } : undefined)
      const page = await requestPage(threadId, request)
      // Persisted row ids are the same ids the stream frames carry, so the
      // snapshot seeds the replay guard.
      rememberEventIds(
        threadId,
        page.messages.map((message) => message.id),
      )
      const toConfirm = sendsToConfirm(heldWindow(get(), threadId), request, page)
      const persisted = toConfirm.length > 0 ? await persistedSends(threadId, toConfirm) : undefined
      set((s) => ({
        ...applyPage(s, threadId, request, page, persisted),
        loadingByThread: { ...s.loadingByThread, [threadId]: false },
      }))
      return page
    } catch (error) {
      set((s) => ({ loadingByThread: { ...s.loadingByThread, [threadId]: false } }))
      throw error
    }
  },

  fetchOlder: async (threadId) => {
    const state = get()
    const paging = state.pagingByThread[threadId]
    if (!paging?.hasOlder || !paging.oldestId || state.loadingOlderByThread[threadId]) return
    const request: MessagePageRequest = { kind: 'older', before: paging.oldestId }
    set((s) => ({ loadingOlderByThread: { ...s.loadingOlderByThread, [threadId]: true } }))
    try {
      const page = await requestPage(threadId, request)
      set((s) => applyPage(s, threadId, request, page))
    } finally {
      set((s) => ({ loadingOlderByThread: { ...s.loadingOlderByThread, [threadId]: false } }))
    }
  },

  expandMessage: async (message) => {
    const full = await rpc(requireConnection(), 'messages:full', { threadId: message.thread_id }, message.id)
    if (!full) return
    set((s) => {
      const held = s.messagesByThread[message.thread_id]
      if (!held?.some((candidate) => candidate.id === full.id)) return s
      return {
        messagesByThread: {
          ...s.messagesByThread,
          [message.thread_id]: held.map((candidate) => (candidate.id === full.id ? full : candidate)),
        },
      }
    })
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
        [threadId]: appendFoldedMessage(s.messagesByThread[threadId] ?? [], msg),
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
      const paging = { ...s.pagingByThread }
      delete paging[threadId]
      return { messagesByThread: updated, pagingByThread: paging }
    }),
}))
