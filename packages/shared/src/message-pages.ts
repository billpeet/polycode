import { foldMessages } from './messages'
import { extractTodosFromMessages, type Todo } from './todos'
import type { Message } from './types'

/**
 * Transcript paging.
 *
 * A large Thread holds tens of thousands of raw rows (streamed deltas are persisted
 * one per row) and well over 100 MB. Clients load the newest page, fetch older pages
 * as the user scrolls up, and catch up after a Turn with only what changed.
 *
 * Page boundaries are fold boundaries: a page never starts with a row that
 * `foldMessages` would merge into the row before it. So folding each page on its own
 * and concatenating the results gives exactly the fold of the whole range, and a
 * client can prepend or append pages without re-folding anything.
 */

/** Folded messages per page. */
export const MESSAGE_PAGE_LIMIT = 150
/** Upper bound on `limit` a client may ask for. */
export const MESSAGE_PAGE_MAX_LIMIT = 1000
/**
 * Raw content+metadata characters per page. A page stops at the first fold boundary
 * past this budget, so one huge message still comes back whole.
 */
export const MESSAGE_PAGE_CHAR_BUDGET = 1_500_000

export type MessageScope = { threadId: string } | { sessionId: string }

export type MessagePageRequest =
  /** The newest messages. */
  | { kind: 'tail'; limit?: number }
  /** Messages strictly older than `before`, which is the id of the oldest message the client holds. */
  | { kind: 'older'; before: string; limit?: number }
  /**
   * Everything from `since` (inclusive) to the end: the id of the newest persisted
   * message the client holds. It is re-sent because later rows may have folded into it.
   */
  | { kind: 'since'; since: string; limit?: number }

export interface MessagePage {
  /** Folded, oldest first. */
  messages: Message[]
  /** True when there are messages older than `messages[0]`. */
  hasOlder: boolean
  /**
   * True when the page joins the request's anchor: an `older` page ends right before
   * `before`, a `since` page starts at `since`. False means the page is a fresh tail
   * that replaces whatever the client holds. This happens for every `tail` request, and
   * when the anchor is gone or a `since` catch-up would be larger than one page.
   */
  anchored: boolean
  /**
   * The scope's current todo list, worked out over the whole scope and not only
   * this page, since the TodoWrite that set it may be far older than the page. Null
   * when there is none. Left out of `older` pages because they don't change it.
   */
  todos?: Todo[] | null
}

/** A row's position in transcript order, `ORDER BY created_at, rowid`. */
export interface MessageRowPosition {
  createdAt: string
  seq: number
}

export interface MessageRow {
  message: Message
  position: MessageRowPosition
}

/** Read access to one scope's raw rows. Implemented over SQLite on the host. */
export interface MessageRowSource {
  /** Where a message id sits in this scope, or null when it is not in the scope. */
  locate(id: string): MessageRowPosition | null
  /** Up to `count` rows strictly older than `before` (or the newest rows when null), newest first. */
  older(before: MessageRowPosition | null, count: number): MessageRow[]
  /** The scope's todo list, as `MessagePage.todos`. */
  todos(): Todo[] | null
}

/** True when `foldMessages` would merge `next` into `previous`, so no page may start at `next`. */
export function continuesPrevious(previous: Message, next: Message): boolean {
  return foldMessages([previous, next]).length < 2
}

const READ_BATCH = 256

function rowChars(message: Message): number {
  return message.content.length + (message.metadata?.length ?? 0)
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return MESSAGE_PAGE_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), MESSAGE_PAGE_MAX_LIMIT)
}

/** Reads a scope newest-first, batching the underlying queries. */
function newestFirst(source: MessageRowSource, before: MessageRowPosition | null): () => MessageRow | null {
  let buffer: MessageRow[] = []
  let index = 0
  let cursor = before
  let exhausted = false
  return () => {
    if (index >= buffer.length) {
      if (exhausted) return null
      buffer = source.older(cursor, READ_BATCH)
      index = 0
      if (buffer.length < READ_BATCH) exhausted = true
      if (buffer.length === 0) return null
      cursor = buffer[buffer.length - 1].position
    }
    return buffer[index++]
  }
}

interface Walk {
  messages: Message[]
  hasOlder: boolean
  reachedStop: boolean
}

/**
 * Walk back from `before` collecting rows until `limit` folded messages or the
 * character budget, ending at a fold boundary, or until the row `stopAtId` has been
 * included.
 */
function walk(source: MessageRowSource, before: MessageRowPosition | null, limit: number, stopAtId: string | null): Walk {
  const next = newestFirst(source, before)
  const collected: Message[] = []
  let chars = 0
  let starts = 0
  let current = next()
  let hasOlder = false
  let reachedStop = false

  while (current) {
    collected.push(current.message)
    chars += rowChars(current.message)
    if (stopAtId !== null && current.message.id === stopAtId) {
      reachedStop = true
      hasOlder = next() !== null
      break
    }
    const previous = next()
    if (!previous) break
    if (!continuesPrevious(previous.message, current.message)) {
      starts += 1
      if (starts >= limit || chars >= MESSAGE_PAGE_CHAR_BUDGET) {
        hasOlder = true
        break
      }
    }
    current = previous
  }

  collected.reverse()
  return { messages: foldMessages(collected), hasOlder, reachedStop }
}

/** Answer a page request against one scope. */
export function readMessagePage(source: MessageRowSource, request: MessagePageRequest): MessagePage {
  const limit = clampLimit(request.limit)

  if (request.kind === 'older') {
    const anchor = source.locate(request.before)
    if (anchor) {
      const { messages, hasOlder } = walk(source, anchor, limit, null)
      return { messages, hasOlder, anchored: true }
    }
  }

  if (request.kind === 'since' && source.locate(request.since)) {
    const { messages, hasOlder, reachedStop } = walk(source, null, limit, request.since)
    return { messages, hasOlder, anchored: reachedStop, todos: source.todos() }
  }

  const { messages, hasOlder } = walk(source, null, limit, null)
  return { messages, hasOlder, anchored: false, todos: source.todos() }
}

/** Answer a page request from an already-loaded full transcript (old hosts, tests). */
export function pageFromFullTranscript(messages: Message[]): MessagePage {
  return { messages, hasOlder: false, anchored: false, todos: extractTodosFromMessages(messages) }
}

// ── Client side ───────────────────────────────────────────────────────────────

/** What a client knows about the part of a transcript it holds. */
export interface TranscriptWindow {
  messages: Message[]
  /** More messages exist before `messages[0]`. */
  hasOlder: boolean
  /** Id of the oldest persisted message held; the anchor for the next `older` request. */
  oldestId: string | null
  /** Id of the newest persisted message held; the anchor for the next `since` request. */
  newestPersistedId: string | null
}

export const EMPTY_TRANSCRIPT_WINDOW: TranscriptWindow = {
  messages: [],
  hasOlder: false,
  oldestId: null,
  newestPersistedId: null,
}

/** The request that brings `window` up to date: a catch-up when anything persisted is held. */
export function refreshRequest(window: TranscriptWindow | undefined): MessagePageRequest {
  return window?.newestPersistedId ? { kind: 'since', since: window.newestPersistedId } : { kind: 'tail' }
}

/**
 * User messages the server has not persisted yet (optimistic sends), which must
 * survive replacing everything after `fromIndex`.
 */
function pendingUserMessages(held: Message[], fromIndex: number, page: Message[]): Message[] {
  const persisted = new Set(page.map((message) => message.id))
  return held.slice(fromIndex).filter((message) => message.role === 'user' && !persisted.has(message.id))
}

function indexAfterPersisted(window: TranscriptWindow): number {
  if (!window.newestPersistedId) return 0
  const index = window.messages.findIndex((message) => message.id === window.newestPersistedId)
  return index === -1 ? window.messages.length : index + 1
}

/**
 * Merge a page into what the client holds. Returns `window` unchanged when the page
 * no longer fits it: an `older` page whose anchor has since been replaced.
 */
export function applyMessagePage(
  window: TranscriptWindow | undefined,
  request: MessagePageRequest,
  page: MessagePage,
): TranscriptWindow {
  const held = window ?? EMPTY_TRANSCRIPT_WINDOW
  const first = page.messages[0]?.id ?? null
  const last = page.messages[page.messages.length - 1]?.id ?? null

  if (request.kind === 'older' && page.anchored) {
    if (held.oldestId !== request.before) return held
    return {
      ...held,
      messages: [...page.messages, ...held.messages],
      hasOlder: page.hasOlder,
      oldestId: first ?? held.oldestId,
    }
  }

  if (request.kind === 'since' && page.anchored) {
    const anchorIndex = held.messages.findIndex((message) => message.id === request.since)
    if (anchorIndex !== -1) {
      return {
        messages: [
          ...held.messages.slice(0, anchorIndex),
          ...page.messages,
          ...pendingUserMessages(held.messages, anchorIndex, page.messages),
        ],
        hasOlder: held.hasOlder,
        oldestId: held.oldestId ?? first,
        newestPersistedId: last ?? held.newestPersistedId,
      }
    }
  }

  // A fresh tail replaces everything; only unsent user messages carry over.
  return {
    messages: [...page.messages, ...pendingUserMessages(held.messages, indexAfterPersisted(held), page.messages)],
    hasOlder: page.hasOlder,
    oldestId: first,
    newestPersistedId: last,
  }
}

/** A Remote Host older than the channel being called. */
export function isUnsupportedChannelError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  const code = (error as { code?: unknown } | null)?.code
  return code === 'REMOTE_UNSUPPORTED_CHANNEL' || /REMOTE_UNSUPPORTED_CHANNEL|Unsupported channel/.test(text)
}
