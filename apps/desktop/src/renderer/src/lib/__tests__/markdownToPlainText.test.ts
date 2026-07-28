import { describe, expect, it } from 'vitest'
import { markdownToPlainText } from '../markdownToPlainText'

describe('markdownToPlainText', () => {
  it('preserves list structure while removing inline formatting markers', () => {
    const markdown = `**Summary**

- First \`item\`
- Second *item*

3. Third **item**
4. Fourth [item](https://example.com)`

    expect(markdownToPlainText(markdown)).toBe(`Summary

- First item
- Second item

3. Third item
4. Fourth item`)
  })

  it('preserves nested list indentation', () => {
    expect(markdownToPlainText('- Parent\n  - Child')).toBe(
      '- Parent\n  - Child'
    )
  })
})
