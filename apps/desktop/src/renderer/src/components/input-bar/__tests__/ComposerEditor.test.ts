import { Fragment, Schema, Slice } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { removeTrailingHardBreak, trimTrailingPasteBreaks } from '../ComposerEditor'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardBreak: { inline: true, group: 'inline' },
  },
})

describe('removeTrailingHardBreak', () => {
  it('keeps the paragraph text and removes its trailing hard break', () => {
    const paragraph = schema.node('paragraph', null, [
      schema.text('first line'),
      schema.node('hardBreak'),
    ])

    expect(removeTrailingHardBreak(paragraph).toJSON()).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'first line' }],
    })
  })
})

describe('trimTrailingPasteBreaks', () => {
  it('returns after trimming a trailing hard break from multiline pasted text', () => {
    const paragraph = schema.node('paragraph', null, [
      schema.text('first line'),
      schema.node('hardBreak'),
    ])
    const slice = new Slice(Fragment.from(paragraph), 0, 0)

    expect(trimTrailingPasteBreaks(slice).content.toJSON()).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'first line' }],
      },
    ])
  })
})
