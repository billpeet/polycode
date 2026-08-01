import { describe, expect, it, vi } from 'vitest'
import {
  filePathFromMarkdownCopyTarget,
  handleMarkdownFileLinkClick,
  markdownFilePathFromHref,
  markdownFileTargetFromHref,
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

  it('extracts a line number from a Codex-style Windows file link', () => {
    expect(
      markdownFileTargetFromHref(
        '/C:/Users/marti/source/Orbit.SeatingApp/src/lib/server/services/event-writes.ts:1847'
      )
    ).toEqual({
      filePath: 'C:\\Users\\marti\\source\\Orbit.SeatingApp\\src\\lib\\server\\services\\event-writes.ts',
      lineNumber: 1847,
    })
  })

  it('passes a linked line number to the file preview selection', () => {
    const preventDefault = vi.fn()
    const selectFile = vi.fn()
    const setRightPanelTab = vi.fn()
    const anchor = {
      getAttribute: (name: string) => {
        if (name === 'data-file-path') return 'C%3A%5Ctmp%5Cmain.ts'
        if (name === 'data-line-number') return '42'
        return null
      },
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
    expect(selectFile).toHaveBeenCalledWith('C:\\tmp\\main.ts', 42)
  })

  it('supports line numbers on POSIX file links', () => {
    expect(markdownFileTargetFromHref('/srv/app/main.ts:73')).toEqual({
      filePath: '/srv/app/main.ts',
      lineNumber: 73,
    })
  })

  it('does not treat zero as a line number', () => {
    expect(markdownFileTargetFromHref('/srv/app/main.ts:0')).toEqual({
      filePath: '/srv/app/main.ts:0',
      lineNumber: null,
    })
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
