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
 * Content+metadata characters per page, counting each message as trimmed. A page
 * stops at the first fold boundary past this budget.
 */
export const MESSAGE_PAGE_CHAR_BUDGET = 1_500_000
/**
 * Longest string a page carries in a message's content or metadata. One command can
 * print tens of MB, and Codex repeats it in `aggregated_output`; pages keep the head
 * and tail of such strings and `messages:full` returns the rest on request.
 */
export const MESSAGE_STRING_LIMIT = 40_000

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
  /** Up to `count` rows at or after `from`, oldest first. */
  newer(from: MessageRowPosition, count: number): MessageRow[]
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

/** Roughly the most a message can weigh after `trimLargeMessage`: content plus a metadata string or two. */
const TRIMMED_MESSAGE_CHARS = 3 * MESSAGE_STRING_LIMIT

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
  // Characters of finished messages, and of the one being collected (its rows so far).
  let chars = 0
  let messageChars = 0
  let starts = 0
  let current = next()
  let hasOlder = false
  let reachedStop = false

  while (current) {
    collected.push(current.message)
    messageChars += rowChars(current.message)
    if (stopAtId !== null && current.message.id === stopAtId) {
      reachedStop = true
      hasOlder = next() !== null
      break
    }
    const previous = next()
    if (!previous) break
    if (!continuesPrevious(previous.message, current.message)) {
      starts += 1
      // Rows that fold together share a role; only non-user messages get trimmed.
      chars += current.message.role === 'user' ? messageChars : Math.min(messageChars, TRIMMED_MESSAGE_CHARS)
      messageChars = 0
      if (starts >= limit || chars >= MESSAGE_PAGE_CHAR_BUDGET) {
        hasOlder = true
        break
      }
    }
    current = previous
  }

  collected.reverse()
  return { messages: foldMessages(collected).map(trimLargeMessage), hasOlder, reachedStop }
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

/**
 * The whole of one folded message: its first row and every row that folds into it.
 * Null when the id is not a message in this scope.
 */
export function readFullMessage(source: MessageRowSource, id: string): Message | null {
  const position = source.locate(id)
  if (!position) return null
  const rows: Message[] = []
  let cursor: MessageRowPosition | null = position
  while (cursor) {
    const batch: MessageRow[] = source.newer(cursor, READ_BATCH)
    // Every batch after the first starts with the row the previous one ended on.
    const fresh = rows.length === 0 ? batch : batch.slice(1)
    let ended = fresh.length === 0
    for (const row of fresh) {
      if (rows.length > 0 && !continuesPrevious(rows[rows.length - 1], row.message)) {
        ended = true
        break
      }
      rows.push(row.message)
    }
    cursor = ended || batch.length < READ_BATCH ? null : batch[batch.length - 1].position
  }
  return foldMessages(rows)[0] ?? null
}

// ── Trimming ──────────────────────────────────────────────────────────────────

function sliceAt(text: string, index: number): number {
  // Never split a surrogate pair.
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

/** Keep a quarter of the limit from the head and the rest from the tail, where command errors land. */
function trimString(text: string): { text: string; omitted: number } {
  if (text.length <= MESSAGE_STRING_LIMIT) return { text, omitted: 0 }
  const headEnd = sliceAt(text, Math.floor(MESSAGE_STRING_LIMIT / 4))
  const tailStart = sliceAt(text, text.length - (MESSAGE_STRING_LIMIT - headEnd))
  const omitted = tailStart - headEnd
  return {
    text: `${text.slice(0, headEnd)}\n\n… ${omitted.toLocaleString('en-US')} characters omitted …\n\n${text.slice(tailStart)}`,
    omitted,
  }
}

function trimValue(value: unknown, omitted: { chars: number }): unknown {
  if (typeof value === 'string') {
    const trimmed = trimString(value)
    omitted.chars += trimmed.omitted
    return trimmed.text
  }
  if (Array.isArray(value)) return value.map((item) => trimValue(item, omitted))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimValue(item, omitted)]))
  }
  return value
}

/**
 * A page's copy of a message: every content or metadata string longer than
 * `MESSAGE_STRING_LIMIT` keeps its head and tail around an "omitted" marker, and
 * `omitted_chars` records the cut. User messages are left whole: their content
 * carries attachments, and the user typed it.
 */
export function trimLargeMessage(message: Message): Message {
  if (message.role === 'user') return message
  const omitted = { chars: 0 }
  const content = trimValue(message.content, omitted) as string
  let metadata = message.metadata
  if (metadata && metadata.length > MESSAGE_STRING_LIMIT) {
    try {
      metadata = JSON.stringify(trimValue(JSON.parse(metadata), omitted))
    } catch {
      // Corrupt metadata renders as none anyway (parseMetadata); don't ship megabytes of it.
      omitted.chars += metadata.length
      metadata = null
    }
  }
  return omitted.chars === 0 ? message : { ...message, content, metadata, omitted_chars: omitted.chars }
}

/**
 * Largest message, in characters, a client offers to show whole. Past this a client
 * would freeze rendering it, so it only says how much was left out.
 */
export const FULL_MESSAGE_LIMIT = { desktop: 5_000_000, mobile: 1_000_000 } as const

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
