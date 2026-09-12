import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupThreadAttachments, getAttachmentDir, saveAttachment } from '../attachments'

/**
 * `threadId` arrives from a client and becomes a path segment under the attachment
 * directory. A remote session may drive these channels, so the segment must never be
 * allowed to climb out — `cleanup` is a recursive delete.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const created: string[] = []

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('attachment thread directories', () => {
  it('save and cleanup round-trip under the attachment dir for a well-formed id', () => {
    const threadId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    created.push(join(getAttachmentDir(), threadId))

    const { tempPath } = saveAttachment(PNG, 'shot.png', threadId)
    expect(tempPath.startsWith(join(getAttachmentDir(), threadId) + sep)).toBe(true)
    expect(tempPath.endsWith('.png')).toBe(true)
    expect(existsSync(tempPath)).toBe(true)

    cleanupThreadAttachments(threadId)
    expect(existsSync(tempPath)).toBe(false)
  })

  it.each([
    '..',
    '../victim',
    '..\\victim',
    'x/../../victim',
    'x\\..\\..\\victim',
    '/abs',
    'C:\\abs',
    '',
    'a b',
    'id\0x',
  ])('refuses to save under a traversing or malformed id: %j', (threadId) => {
    expect(() => saveAttachment(PNG, 'shot.png', threadId)).toThrow(/thread id/i)
  })

  it('refuses to delete anything outside the attachment dir', () => {
    const victim = mkdtempSync(join(tmpdir(), 'polycode-victim-'))
    created.push(victim)
    writeFileSync(join(victim, 'keep.txt'), 'keep')
    const escape = `..${sep}${victim.split(sep).pop()}`

    expect(() => cleanupThreadAttachments(escape)).toThrow(/thread id/i)
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
  })
})
