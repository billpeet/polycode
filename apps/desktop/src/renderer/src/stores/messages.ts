import { create } from 'zustand'
import {
  appendFoldedMessage,
  applyMessagePage,
  eventRole,
  isUnsupportedChannelError,
  pageFromFullTranscript,
  refreshRequest,
  type MessagePage,
  type MessagePageRequest,
  type MessageScope,
} from '@polycode/shared'
import { Message, OutputEvent } from '../types/ipc'
import { client } from '../lib/client'

/** What is known about the part of a transcript held in `messagesByThread`/`messagesBySession`. */
export interface TranscriptPaging {
  /** More messages exist before the first one held. */
  hasOlder: boolean
  /** Anchor for the next `older` request. */
  oldestId: string | null
  /** Anchor for the next `since` request. */
  newestPersistedId: string | null
  loadingOlder: boolean
}

interface MessageStore {
  messagesByThread: Record<string, Message[]>
  messagesBySession: Record<string, Message[]>
  pagingByThread: Record<string, TranscriptPaging>
  pagingBySession: Record<string, TranscriptPaging>

  /**
   * Bring the held transcript up to date: the newest page on first load, then only
   * what changed since. Resolves with the page, whose `todos` cover the whole scope,
   * or undefined when the host could not be reached.
   */
  fetch: (threadId: string) => Promise<MessagePage | undefined>
  fetchBySession: (sessionId: string) => Promise<MessagePage | undefined>
  /** Prepend the page before the oldest message held, if there is one. */
  fetchOlder: (threadId: string) => Promise<void>
  fetchOlderBySession: (sessionId: string) => Promise<void>
  /** Replace a page's trimmed copy of `message` (`omitted_chars`) with the whole message. */
  expandMessage: (message: Message) => Promise<void>

  appendEvent: (threadId: string, event: OutputEvent) => void
  appendEventToSession: (sessionId: string, threadId: string, event: OutputEvent) => void
  /** One store write for a batch of frames; see lib/outputBatcher.ts. */
  appendEvents: (threadId: string, events: OutputEvent[]) => void
  appendEventsToSession: (sessionId: string, threadId: string, events: OutputEvent[]) => void

  appendUserMessage: (threadId: string, content: string, messageId?: string) => void
  appendUserMessageToSession: (sessionId: string, threadId: string, content: string, messageId?: string) => void
  moveThreadMessages: (fromThreadId: string, toThreadId: string) => void

  clear: (threadId: string) => void
  clearSession: (sessionId: string) => void
}

/**
 * One page from the host. A host older than `messages:page` answers with its whole
 * transcript instead, which then never has older pages to load.
 */
async function requestPage(scope: MessageScope, request: MessagePageRequest): Promise<MessagePage | undefined> {
  try {
    return await client.refresh('messages:page', scope, request)
  } catch (error) {
    if (!isUnsupportedChannelError(error)) throw error
    if (request.kind === 'older') return { messages: [], hasOlder: false, anchored: true }
    const messages = 'threadId' in scope
      ? await client.refresh('messages:list', scope.threadId)
      : await client.refresh('messages:listBySession', scope.sessionId)
    return messages ? pageFromFullTranscript(messages) : undefined
  }
}

const NO_PAGING: TranscriptPaging = { hasOlder: false, oldestId: null, newestPersistedId: null, loadingOlder: false }

/** The thread-keyed and the session-keyed halves of the store, which page identically. */
interface Half {
  scope: (id: string) => MessageScope
  messages: (s: MessageStore) => Record<string, Message[]>
  paging: (s: MessageStore) => Record<string, TranscriptPaging>
  write: (messages: Record<string, Message[]>, paging: Record<string, TranscriptPaging>) => Partial<MessageStore>
}

const THREADS: Half = {
  scope: (threadId) => ({ threadId }),
  messages: (s) => s.messagesByThread,
  paging: (s) => s.pagingByThread,
  write: (messagesByThread, pagingByThread) => ({ messagesByThread, pagingByThread }),
}

const SESSIONS: Half = {
  scope: (sessionId) => ({ sessionId }),
  messages: (s) => s.messagesBySession,
  paging: (s) => s.pagingBySession,
  write: (messagesBySession, pagingBySession) => ({ messagesBySession, pagingBySession }),
}

/** Put `full` in place of the message with its id, wherever a transcript holds it. */
function replaceMessage(byKey: Record<string, Message[]>, key: string | null, full: Message): Record<string, Message[]> {
  const messages = key ? byKey[key] : undefined
  const index = messages?.findIndex((message) => message.id === full.id) ?? -1
  if (!messages || index === -1) return byKey
  return { ...byKey, [key!]: messages.map((message, at) => (at === index ? full : message)) }
}

/** The transient message a streamed frame becomes, or nothing for frames that are not messages. */
function streamMessageFor(threadId: string, sessionId: string | null, event: OutputEvent): Message[] {
  if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return []
  return [{
    id: `stream-${Date.now()}-${Math.random()}`,
    thread_id: threadId,
    session_id: sessionId ?? event.sessionId ?? null,
    role: eventRole(event),
    content: event.content,
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    created_at: new Date().toISOString()
  }]
}

// Paging helpers shared by the thread- and session-keyed halves of the store.
const windowOf = (half: Half, id: string) => {
  const state = useMessageStore.getState()
  const messages = half.messages(state)[id]
  const paging = half.paging(state)[id]
  if (!messages && !paging) return undefined
  return { messages: messages ?? [], ...(paging ?? NO_PAGING) }
}

const setLoadingOlder = (half: Half, id: string, loadingOlder: boolean) =>
  useMessageStore.setState((s) => half.write(half.messages(s), {
    ...half.paging(s),
    [id]: { ...(half.paging(s)[id] ?? NO_PAGING), loadingOlder },
  }))

const apply = (half: Half, id: string, request: MessagePageRequest, page: MessagePage) =>
  useMessageStore.setState((s) => {
    const held = half.paging(s)[id]
    const messages = half.messages(s)[id]
    const next = applyMessagePage(
      messages || held ? { messages: messages ?? [], ...(held ?? NO_PAGING) } : undefined,
      request,
      page,
    )
    return half.write({ ...half.messages(s), [id]: next.messages }, {
      ...half.paging(s),
      [id]: {
        hasOlder: next.hasOlder,
        oldestId: next.oldestId,
        newestPersistedId: next.newestPersistedId,
        loadingOlder: held?.loadingOlder ?? false,
      },
    })
  })

const refresh = async (half: Half, id: string) => {
  const request = refreshRequest(windowOf(half, id))
  const page = await requestPage(half.scope(id), request)
  if (page) apply(half, id, request, page)
  return page
}

const loadOlder = async (half: Half, id: string) => {
  const paging = half.paging(useMessageStore.getState())[id]
  if (!paging?.hasOlder || !paging.oldestId || paging.loadingOlder) return
  const request: MessagePageRequest = { kind: 'older', before: paging.oldestId }
  setLoadingOlder(half, id, true)
  try {
    const page = await requestPage(half.scope(id), request)
    if (page) apply(half, id, request, page)
  } finally {
    setLoadingOlder(half, id, false)
  }
}

export const useMessageStore = create<MessageStore>((set) => ({
  messagesByThread: {},
  messagesBySession: {},
  pagingByThread: {},
  pagingBySession: {},

  fetch: (threadId) => refresh(THREADS, threadId),
  fetchBySession: (sessionId) => refresh(SESSIONS, sessionId),
  fetchOlder: (threadId) => loadOlder(THREADS, threadId),
  fetchOlderBySession: (sessionId) => loadOlder(SESSIONS, sessionId),

  expandMessage: async (message) => {
    const full = await client.invoke('messages:full', { threadId: message.thread_id }, message.id)
    if (!full) return
    set((s) => ({
      messagesByThread: replaceMessage(s.messagesByThread, message.thread_id, full),
      messagesBySession: replaceMessage(s.messagesBySession, message.session_id, full),
    }))
  },

  appendEvent: (threadId, event) => {
    if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return

    // Determine role: check metadata.role first (for question answers), then infer from type
    const role = eventRole(event)
    const msg: Message = {
      id: `stream-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: event.sessionId ?? null,
      role,
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: appendFoldedMessage(s.messagesByThread[threadId] ?? [], msg)
      }
    }))
  },

  appendEventToSession: (sessionId, threadId, event) => {
    if (event.type === 'status' || event.type === 'rate_limit' || event.type === 'usage') return

    const role = eventRole(event)
    const msg: Message = {
      id: `stream-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: sessionId,
      role,
      content: event.content,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: appendFoldedMessage(s.messagesBySession[sessionId] ?? [], msg)
      }
    }))
  },

  appendEvents: (threadId, events) => {
    const incoming = events.flatMap((event) => streamMessageFor(threadId, null, event))
    if (incoming.length === 0) return
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: incoming.reduce(appendFoldedMessage, s.messagesByThread[threadId] ?? [])
      }
    }))
  },

  appendEventsToSession: (sessionId, threadId, events) => {
    const incoming = events.flatMap((event) => streamMessageFor(threadId, sessionId, event))
    if (incoming.length === 0) return
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: incoming.reduce(appendFoldedMessage, s.messagesBySession[sessionId] ?? [])
      }
    }))
  },

  appendUserMessage: (threadId, content, messageId) => {
    const msg: Message = {
      id: messageId ?? `optimistic-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: null,
      role: 'user',
      content,
      metadata: null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...(s.messagesByThread[threadId] ?? []), msg]
      }
    }))
  },

  appendUserMessageToSession: (sessionId, threadId, content, messageId) => {
    const msg: Message = {
      id: messageId ?? `optimistic-${Date.now()}-${Math.random()}`,
      thread_id: threadId,
      session_id: sessionId,
      role: 'user',
      content,
      metadata: null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), msg]
      }
    }))
  },

  moveThreadMessages: (fromThreadId, toThreadId) =>
    set((s) => {
      const source = s.messagesByThread[fromThreadId] ?? []
      if (source.length === 0) return s
      const updated = { ...s.messagesByThread }
      delete updated[fromThreadId]
      updated[toThreadId] = [
        ...(updated[toThreadId] ?? []),
        ...source.map((message) => ({ ...message, thread_id: toThreadId })),
      ]
      // A pending thread's messages are all optimistic, so there is no paging to carry.
      const paging = { ...s.pagingByThread }
      delete paging[fromThreadId]
      return { messagesByThread: updated, pagingByThread: paging }
    }),

  clear: (threadId) =>
    set((s) => {
      const updated = { ...s.messagesByThread }
      delete updated[threadId]
      const paging = { ...s.pagingByThread }
      delete paging[threadId]
      return { messagesByThread: updated, pagingByThread: paging }
    }),

  clearSession: (sessionId) =>
    set((s) => {
      const updated = { ...s.messagesBySession }
      delete updated[sessionId]
      const paging = { ...s.pagingBySession }
      delete paging[sessionId]
      return { messagesBySession: updated, pagingBySession: paging }
    })
}))
