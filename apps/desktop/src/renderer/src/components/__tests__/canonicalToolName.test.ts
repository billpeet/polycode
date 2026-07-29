import { describe, expect, it } from 'vitest'
import { canonicalToolName } from '@polycode/shared'

describe('canonicalToolName', () => {
  it('passes canonical Claude names through unchanged', () => {
    expect(canonicalToolName('Read')).toBe('Read')
    expect(canonicalToolName('Edit')).toBe('Edit')
    expect(canonicalToolName('Grep')).toBe('Grep')
    expect(canonicalToolName('TodoWrite')).toBe('TodoWrite')
  })

  it('maps Cursor display names onto the canonical set', () => {
    expect(canonicalToolName('Read file')).toBe('Read')
    expect(canonicalToolName('Edit file')).toBe('Edit')
    expect(canonicalToolName('Terminal')).toBe('Bash')
  })

  it('maps the metadata kind discriminator when the name is unrecognised', () => {
    expect(canonicalToolName('anything', { kind: 'search' })).toBe('Grep')
    expect(canonicalToolName('anything', { kind: 'read' })).toBe('Read')
    expect(canonicalToolName('anything', { kind: 'edit' })).toBe('Edit')
    expect(canonicalToolName('anything', { kind: 'execute' })).toBe('Bash')
  })

  it('is case-insensitive on the tool name and the kind', () => {
    expect(canonicalToolName('BASH')).toBe('Bash')
    expect(canonicalToolName('READ FILE')).toBe('Read')
    expect(canonicalToolName('anything', { kind: 'SEARCH' })).toBe('Grep')
  })

  it('ignores metadata that is absent, null, or has a non-string kind', () => {
    expect(canonicalToolName('Bash')).toBe('Bash')
    expect(canonicalToolName('Bash', null)).toBe('Bash')
    expect(canonicalToolName('Custom', { kind: 42 })).toBe('Custom')
    expect(canonicalToolName('Custom', {})).toBe('Custom')
  })

  it('returns unknown tool names verbatim, preserving their casing', () => {
    expect(canonicalToolName('mcp__sanity__query_documents')).toBe('mcp__sanity__query_documents')
    expect(canonicalToolName('FileChange')).toBe('FileChange')
  })
})
