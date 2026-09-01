import { describe, expect, it } from 'vitest'
import {
  findUrlMatches,
  rangeForOffset,
  shouldOpenCommandLogLinkInternally,
  type LineSegment,
} from '../xtermLinks'

describe('findUrlMatches', () => {
  it('finds a portless https *.localhost URL at end of line', () => {
    const line = 'Starting App as [paysys-app] -- https://paysys-app.localhost'
    const matches = findUrlMatches(line)
    expect(matches).toHaveLength(1)
    const start = line.indexOf('https://')
    expect(matches[0]).toEqual({
      start,
      end: line.length,
      url: 'https://paysys-app.localhost',
    })
  })

  it('finds a loopback IP URL with a port', () => {
    const matches = findUrlMatches('  \u2192 Local:   http://127.0.0.1:4324/')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('http://127.0.0.1:4324/')
  })

  it('trims sentence punctuation the regex swallowed', () => {
    const matches = findUrlMatches('Visit https://a.localhost, then https://b.localhost.')
    expect(matches).toHaveLength(2)
    expect(matches[0].url).toBe('https://a.localhost')
    expect(matches[1].url).toBe('https://b.localhost')
  })

  it('finds multiple URLs in one line', () => {
    const matches = findUrlMatches('api on http://localhost:3000 and docs at https://example.com/docs?q=1')
    expect(matches.map((m) => m.url)).toEqual([
      'http://localhost:3000',
      'https://example.com/docs?q=1',
    ])
  })

  it('ignores text without a scheme', () => {
    expect(findUrlMatches('run paysys-app.localhost:443 directly')).toEqual([])
  })

  it('keeps query strings and fragments but stops at whitespace', () => {
    const matches = findUrlMatches('PORTLESS_URL=https://app.localhost/x?y=1#z done')
    expect(matches[0].url).toBe('https://app.localhost/x?y=1#z')
  })
})

describe('shouldOpenCommandLogLinkInternally', () => {
  it.each([
    'http://localhost:3000',
    'https://app.localhost/path',
    'http://127.0.0.1:8080',
    'http://[::1]:5173',
  ])('uses the internal browser for %s during remote control', (url) => {
    expect(shouldOpenCommandLogLinkInternally(url, true)).toBe(true)
  })

  it('uses the external browser for loopback URLs without remote control', () => {
    expect(shouldOpenCommandLogLinkInternally('http://localhost:3000', false)).toBe(false)
  })

  it.each([
    'https://example.com/docs',
    'http://localhost.example.com',
  ])('uses the external browser for %s during remote control', (url) => {
    expect(shouldOpenCommandLogLinkInternally(url, true)).toBe(false)
  })
})

describe('rangeForOffset', () => {
  const single: LineSegment[] = [{ row: 5, start: 0, length: 80 }]

  it('maps offsets to 1-based cells, end exclusive', () => {
    expect(rangeForOffset(single, 35, 64)).toEqual({
      start: { x: 36, y: 6 },
      end: { x: 65, y: 6 },
    })
  })

  it('maps a match that ends exactly at a wrapped-row boundary into the previous segment', () => {
    const wrapped: LineSegment[] = [
      { row: 5, start: 0, length: 80 },
      { row: 6, start: 80, length: 80 },
      { row: 7, start: 160, length: 80 },
    ]
    // A URL ending at offset 80 covers the last cell of row 5 only.
    expect(rangeForOffset(wrapped, 35, 80)).toEqual({
      start: { x: 36, y: 6 },
      end: { x: 81, y: 6 },
    })
  })

  it('maps a match spanning two wrapped rows', () => {
    const wrapped: LineSegment[] = [
      { row: 5, start: 0, length: 80 },
      { row: 6, start: 80, length: 80 },
    ]
    expect(rangeForOffset(wrapped, 70, 100)).toEqual({
      start: { x: 71, y: 6 },
      end: { x: 21, y: 7 },
    })
  })

  it('returns null when the start offset falls outside every segment', () => {
    expect(rangeForOffset(single, 100, 120)).toBeNull()
  })
})
