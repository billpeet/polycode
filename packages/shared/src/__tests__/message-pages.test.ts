import { describe, expect, it } from 'vitest'
import {
  MESSAGE_PAGE_CHAR_BUDGET,
  applyMessagePage,
  continuesPrevious,
  extractTodosFromMessages,
  foldMessages,
  isUnsupportedChannelError,
  readMessagePage,
  refreshRequest,
  type Message,
  type MessagePage,
  type MessageRowSource,
  type TranscriptWindow,
} from '../index'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let nextId = 0
function row(role: Message['role'], content: string, metadata: Record<string, unknown> | null = null): Message {
  const id = `r${nextId++}`
  return { id, thread_id: 't1', session_id: null, role, content, metadata: metadata ? JSON.stringify(metadata) : null, created_at: '' }
}

/** Streams heavy in merge chains: runs of text/thinking deltas and tool_result chunks. */
function randomStream(seed: number, length: number): Message[] {
  const rand = mulberry32(seed)
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)]
  const out: Message[] = []
  while (out.length < length) {
    const role = pick(['assistant', 'assistant', 'assistant', 'user', 'system'] as const)
    const type = pick([undefined, 'text', 'thinking', 'tool_result', 'tool_call'])
    const scope = pick([{}, {}, { agent_parent_tool_use_id: 'tool-p' }])
    const run = role === 'user' ? 1 : 1 + Math.floor(rand() * 6)
    const toolUseId = pick(['tu-1', 'tu-2'])
    for (let i = 0; i < run && out.length < length; i++) {
      const metadata: Record<string, unknown> = { ...scope }
      if (type) metadata.type = type
      if (type === 'tool_result') metadata.tool_use_id = toolUseId
      out.push(row(role, `${out.length};`, Object.keys(metadata).length ? metadata : null))
    }
  }
  return out
}

/** In-memory MessageRowSource over rows in transcript order. */
function sourceOf(rows: Message[]): MessageRowSource & { reads: number } {
  const positioned = rows.map((message, seq) => ({ message, position: { createdAt: '2026-01-01T00:00:00.000Z', seq } }))
  const source = {
    reads: 0,
    locate: (id: string) => positioned.find((entry) => entry.message.id === id)?.position ?? null,
    older: (before: { seq: number } | null, count: number) => {
      source.reads += 1
      const end = before ? before.seq : positioned.length
      return positioned.slice(Math.max(end - count, 0), end).reverse()
    },
    todos: () => extractTodosFromMessages(rows),
  }
  return source
}

describe('readMessagePage', () => {
  it('pages concatenate to exactly the fold of the whole transcript', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rows = randomStream(seed, 400)
      const source = sourceOf(rows)
      const limit = 1 + (seed % 9)

      let page = readMessagePage(source, { kind: 'tail', limit })
      let joined = page.messages
      let guard = 0
      while (page.hasOlder) {
        page = readMessagePage(source, { kind: 'older', before: joined[0].id, limit })
        expect(page.anchored).toBe(true)
        joined = [...page.messages, ...joined]
        if (++guard > 1000) throw new Error('paging did not terminate')
      }

      expect(joined).toEqual(foldMessages(rows))
    }
  })

  it('starts every page at a row that does not continue the one before it', () => {
    const rows = randomStream(7, 300)
    const source = sourceOf(rows)
    const page = readMessagePage(source, { kind: 'tail', limit: 5 })
    const startIndex = rows.findIndex((message) => message.id === page.messages[0].id)
    expect(startIndex).toBeGreaterThan(0)
    expect(continuesPrevious(rows[startIndex - 1], rows[startIndex])).toBe(false)
  })

  it('returns the newest messages, flags older ones, and reports todos for the whole scope', () => {
    const todoCall = row('assistant', 'TodoWrite', { type: 'tool_call', name: 'TodoWrite', input: { todos: [{ content: 'a', activeForm: 'A', status: 'pending' }] } })
    const rows = [todoCall, ...Array.from({ length: 10 }, (_, index) => row(index % 2 ? 'assistant' : 'user', `m${index}`))]
    const page = readMessagePage(sourceOf(rows), { kind: 'tail', limit: 3 })

    expect(page.messages.map((message) => message.content)).toEqual(['m7', 'm8', 'm9'])
    expect(page.hasOlder).toBe(true)
    expect(page.anchored).toBe(false)
    expect(page.todos).toEqual([{ content: 'a', activeForm: 'A', status: 'pending' }])
  })

  it('keeps a streamed chain whole even when it alone exceeds the limit', () => {
    const rows = [row('user', 'go'), ...Array.from({ length: 50 }, (_, index) => row('assistant', `${index},`, { type: 'text' }))]
    const page = readMessagePage(sourceOf(rows), { kind: 'tail', limit: 1 })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0].content.split(',')).toHaveLength(51)
    expect(page.hasOlder).toBe(true)
  })

  it('stops at the character budget, but never returns less than one message', () => {
    const huge = 'x'.repeat(MESSAGE_PAGE_CHAR_BUDGET)
    const rows = [row('user', 'a'), row('assistant', huge), row('user', 'b'), row('assistant', huge)]
    const page = readMessagePage(sourceOf(rows), { kind: 'tail', limit: 100 })
    expect(page.messages.map((message) => message.id)).toEqual([rows[3].id])
    expect(page.hasOlder).toBe(true)
  })

  it('a since request returns the anchor and everything after it', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(index % 2 ? 'assistant' : 'user', `m${index}`))
    const page = readMessagePage(sourceOf(rows), { kind: 'since', since: rows[15].id })
    expect(page.anchored).toBe(true)
    expect(page.hasOlder).toBe(true)
    expect(page.messages.map((message) => message.id)).toEqual(rows.slice(15).map((message) => message.id))
    expect(page.todos).toBeNull()
  })

  it('a since request that would exceed one page falls back to a fresh tail', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(index % 2 ? 'assistant' : 'user', `m${index}`))
    const page = readMessagePage(sourceOf(rows), { kind: 'since', since: rows[2].id, limit: 5 })
    expect(page.anchored).toBe(false)
    expect(page.messages.map((message) => message.content)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19'])
  })

  it('an unknown anchor falls back to a fresh tail', () => {
    const rows = Array.from({ length: 4 }, (_, index) => row(index % 2 ? 'assistant' : 'user', `m${index}`))
    for (const request of [{ kind: 'older', before: 'gone' }, { kind: 'since', since: 'gone' }] as const) {
      const page = readMessagePage(sourceOf(rows), request)
      expect(page.anchored).toBe(false)
      expect(page.messages).toHaveLength(4)
    }
  })

  it('an empty scope returns an empty page', () => {
    expect(readMessagePage(sourceOf([]), { kind: 'tail' })).toEqual({ messages: [], hasOlder: false, anchored: false, todos: null })
  })
})

describe('applyMessagePage', () => {
  const persisted = (id: string, role: Message['role'] = 'assistant'): Message => ({
    id, thread_id: 't1', session_id: null, role, content: id, metadata: null, created_at: '',
  })
  const ids = (window: TranscriptWindow) => window.messages.map((message) => message.id)

  it('a tail page replaces what is held and records both anchors', () => {
    const page: MessagePage = { messages: [persisted('a'), persisted('b')], hasOlder: true, anchored: false }
    const window = applyMessagePage(undefined, { kind: 'tail' }, page)
    expect(window).toEqual({ messages: page.messages, hasOlder: true, oldestId: 'a', newestPersistedId: 'b' })
    expect(refreshRequest(window)).toEqual({ kind: 'since', since: 'b' })
    expect(refreshRequest(undefined)).toEqual({ kind: 'tail' })
  })

  it('an older page is prepended', () => {
    const held: TranscriptWindow = { messages: [persisted('c'), persisted('d')], hasOlder: true, oldestId: 'c', newestPersistedId: 'd' }
    const window = applyMessagePage(held, { kind: 'older', before: 'c' }, { messages: [persisted('a'), persisted('b')], hasOlder: false, anchored: true })
    expect(ids(window)).toEqual(['a', 'b', 'c', 'd'])
    expect(window.hasOlder).toBe(false)
    expect(window.oldestId).toBe('a')
    expect(window.newestPersistedId).toBe('d')
  })

  it('an older page that no longer fits is dropped', () => {
    const held: TranscriptWindow = { messages: [persisted('x')], hasOlder: true, oldestId: 'x', newestPersistedId: 'x' }
    const window = applyMessagePage(held, { kind: 'older', before: 'c' }, { messages: [persisted('a')], hasOlder: false, anchored: true })
    expect(window).toBe(held)
  })

  it('a since page replaces the anchor onwards and keeps unsent user messages', () => {
    const held: TranscriptWindow = {
      messages: [persisted('a'), persisted('b'), persisted('stream-1'), persisted('optimistic-1', 'user'), persisted('sent', 'user')],
      hasOlder: true,
      oldestId: 'a',
      newestPersistedId: 'b',
    }
    const window = applyMessagePage(held, { kind: 'since', since: 'b' }, {
      messages: [persisted('b'), persisted('sent', 'user'), persisted('c')],
      hasOlder: true,
      anchored: true,
    })
    expect(ids(window)).toEqual(['a', 'b', 'sent', 'c', 'optimistic-1'])
    expect(window.hasOlder).toBe(true)
    expect(window.oldestId).toBe('a')
    expect(window.newestPersistedId).toBe('c')
  })

  it('an unanchored page drops older pages but not unsent user messages', () => {
    const held: TranscriptWindow = {
      messages: [persisted('old-user', 'user'), persisted('b'), persisted('optimistic-1', 'user')],
      hasOlder: false,
      oldestId: 'old-user',
      newestPersistedId: 'b',
    }
    const window = applyMessagePage(held, { kind: 'since', since: 'b' }, { messages: [persisted('y'), persisted('z')], hasOlder: true, anchored: false })
    expect(ids(window)).toEqual(['y', 'z', 'optimistic-1'])
    expect(window.hasOlder).toBe(true)
    expect(window.oldestId).toBe('y')
  })
})

describe('isUnsupportedChannelError', () => {
  it('recognises old hosts through every transport', () => {
    expect(isUnsupportedChannelError(new Error('Unsupported channel'))).toBe(true)
    expect(isUnsupportedChannelError(new Error("Error invoking remote method 'messages:page': Error: [REMOTE_UNSUPPORTED_CHANNEL] Upgrade the Remote Host"))).toBe(true)
    expect(isUnsupportedChannelError(Object.assign(new Error('x'), { code: 'REMOTE_UNSUPPORTED_CHANNEL' }))).toBe(true)
    expect(isUnsupportedChannelError(new Error('Remote host is busy'))).toBe(false)
  })
})
