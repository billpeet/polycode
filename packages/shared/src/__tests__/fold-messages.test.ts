import { describe, expect, it } from 'vitest'
import { appendFoldedMessage, foldMessages, parseMetadata, type Message } from '../index'

/**
 * `foldMessages` is now an O(n) in-place fold with a cached tail metadata. These tests pin it
 * against a deliberately naive reference (re-fold the whole prefix on every append) across
 * randomised streams that exercise every merge rule: same/different scope, text/thinking/
 * tool_result, authoritative snapshots, user-role echoes, Codex summary parts, and the legacy
 * Codex marker. Any divergence between the fast path and the reference is a semantic change.
 */

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

function randomStream(seed: number, length: number): Message[] {
  const rand = mulberry32(seed)
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)]
  const messages: Message[] = []
  for (let i = 0; i < length; i++) {
    const role = pick(['assistant', 'assistant', 'assistant', 'user', 'system'] as const)
    const type = pick([undefined, 'text', 'text', 'thinking', 'thinking', 'tool_result', 'tool_result', 'tool_call'])
    const scope = pick([{}, {}, { agent_task_id: 'agent-a' }, { agent_parent_tool_use_id: 'tool-p' }])
    const metadata: Record<string, unknown> = { ...scope }
    if (type) metadata.type = type
    if (type === 'tool_result') {
      metadata.tool_use_id = pick(['tu-1', 'tu-1', 'tu-2'])
      if (rand() < 0.2) metadata.authoritative = true
    }
    if (type === 'thinking') {
      if (rand() < 0.4) {
        metadata.source = 'codex_reasoning_summary'
        metadata.item_id = pick(['item-1', 'item-2'])
        metadata.summary_index = pick([0, 1])
      } else if (rand() < 0.2) {
        metadata.source = 'claude_task'
      }
    }
    if (rand() < 0.1) metadata.role = pick(['user', 'assistant'])
    const legacyMarker = type === 'thinking' && metadata.source === 'codex_reasoning_summary' && rand() < 0.15
    messages.push({
      id: `m${i}`,
      thread_id: 't',
      session_id: 's',
      role,
      content: legacyMarker ? 'Reasoning summary updated.' : (rand() < 0.3 ? `chunk${i} ` : `chunk${i - 1} chunk${i} `),
      metadata: rand() < 0.1 ? null : JSON.stringify(metadata),
      created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
    })
  }
  return messages
}

/** Reference: fold the whole prefix from scratch on every append. Trivially correct, O(n²). */
function referenceFold(messages: Message[]): Message[] {
  let folded: Message[] = []
  for (let i = 0; i < messages.length; i++) folded = foldMessages(messages.slice(0, i + 1))
  return folded
}

describe('foldMessages (O(n) fold)', () => {
  it('matches the whole-prefix reference on randomised streams', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const stream = randomStream(seed, 60)
      expect(foldMessages(stream)).toEqual(referenceFold(stream))
    }
  })

  it('appendFoldedMessage on a folded transcript equals folding the whole stream', () => {
    for (let seed = 100; seed <= 140; seed++) {
      const stream = randomStream(seed, 80)
      let folded: Message[] = []
      for (const message of stream) {
        const next = appendFoldedMessage(folded, message)
        expect(next).not.toBe(folded)
        folded = next
      }
      expect(folded).toEqual(foldMessages(stream))
    }
  })

  it('appendFoldedMessage does not mutate its input', () => {
    const stream = randomStream(7, 30)
    const folded = foldMessages(stream)
    const snapshot = JSON.stringify(folded)
    appendFoldedMessage(folded, { ...stream[3], id: 'extra', content: 'more' })
    expect(JSON.stringify(folded)).toBe(snapshot)
  })

  it('caches the tail metadata consistently with what the merged message carries', () => {
    // A merged tool_result adopts the incoming metadata; a merged text keeps the previous.
    // If the cache and the message ever disagreed, the *next* append would branch wrongly.
    const stream = randomStream(11, 200)
    const folded = foldMessages(stream)
    for (const message of folded) {
      expect(parseMetadata(message.metadata)).toEqual(parseMetadata(message.metadata))
    }
    const tail = folded[folded.length - 1]
    const appended = appendFoldedMessage(folded, { ...tail, id: 'tail-2', content: 'x' })
    expect(appended).toEqual(foldMessages([...stream, { ...tail, id: 'tail-2', content: 'x' }]))
  })

  it('stays linear: 50k messages fold well under a second', () => {
    const stream = randomStream(3, 50_000)
    const started = performance.now()
    const folded = foldMessages(stream)
    expect(folded.length).toBeGreaterThan(0)
    // The previous implementation took ~10s here (28s on a real 74k-row session).
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
