import { describe, expect, it, vi } from 'vitest'
import {
  filePathFromMarkdownCopyTarget,
  handleMarkdownFileLinkClick,
  markdownFilePathFromHref,
} from '../markdownFileLinks'

describe('markdown file links', () => {
  it('decodes the Windows file href emitted by marked', () => {
    expect(
      markdownFilePathFromHref(
        'C:%5CUsers%5Cmarti%5COneDrive%20-%20Metroid%5CDocuments%5CHost%20Inventory.md'
      )
    ).toBe('C:\\Users\\marti\\OneDrive - Metroid\\Documents\\Host Inventory.md')
  })

  it('selects a linked file for preview when its anchor is clicked', () => {
    const preventDefault = vi.fn()
    const selectFile = vi.fn()
    const setRightPanelTab = vi.fn()
    const anchor = {
      getAttribute: (name: string) =>
        name === 'data-file-path'
          ? 'C:%5CUsers%5Cmarti%5CDocuments%5CHost%20Inventory.md'
          : null,
    }
    const target = {
      closest: (selector: string) =>
        selector === 'a[data-file-path], a[href]' ? anchor : null,
    }

    const handled = handleMarkdownFileLinkClick(
      { target, preventDefault },
      { selectFile, setRightPanelTab }
    )

    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(selectFile).toHaveBeenCalledWith(
      'C:\\Users\\marti\\Documents\\Host Inventory.md'
    )
    expect(setRightPanelTab).toHaveBeenCalledWith('files')
  })

  it('leaves web links alone', () => {
    expect(markdownFilePathFromHref('https://example.com/file.md')).toBeNull()
  })

  it('extracts the decoded path from a file-link copy button', () => {
    const button = {
      getAttribute: (name: string) =>
        name === 'data-file-path'
          ? 'C%3A%5CUsers%5Cmarti%5CDocuments%5CHost%20Inventory.md'
          : null,
    }
    const target = {
      closest: (selector: string) =>
        selector === '.file-path-copy-btn[data-file-path]' ? button : null,
    }

    expect(filePathFromMarkdownCopyTarget(target)).toBe(
      'C:\\Users\\marti\\Documents\\Host Inventory.md'
    )
  })
})
