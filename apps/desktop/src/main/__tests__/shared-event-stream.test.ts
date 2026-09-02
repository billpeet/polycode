import { describe, expect, it } from 'vitest'
import { parseSseFrame } from '@polycode/shared'

describe('parseSseFrame', () => {
  it('parses an app event frame', () => {
    expect(parseSseFrame('event: app\ndata: {"channel":"thread:complete:t1","args":[42]}'))
      .toEqual({ channel: 'thread:complete:t1', args: [42] })
  })

  it('handles CRLF line endings from a proxied host', () => {
    expect(parseSseFrame('event: app\r\ndata: {"channel":"files:changed","args":[]}'))
      .toEqual({ channel: 'files:changed', args: [] })
  })

  it('joins multi-line data per the SSE spec', () => {
    expect(parseSseFrame('event: app\ndata: {"channel":"a",\ndata: "args":[]}'))
      .toEqual({ channel: 'a', args: [] })
  })

  it('discards keepalive comments and non-app events', () => {
    expect(parseSseFrame(': 1756800000000')).toBeNull()
    expect(parseSseFrame('event: ping\ndata: {}')).toBeNull()
    expect(parseSseFrame('data: {"channel":"x","args":[]}')).toBeNull() // default event name
  })

  it('discards malformed or mis-shaped payloads from a stale host', () => {
    expect(parseSseFrame('event: app\ndata: {not json')).toBeNull()
    expect(parseSseFrame('event: app\ndata: {"channel":42,"args":[]}')).toBeNull()
    expect(parseSseFrame('event: app\ndata: {"channel":"x","args":"nope"}')).toBeNull()
  })
})
