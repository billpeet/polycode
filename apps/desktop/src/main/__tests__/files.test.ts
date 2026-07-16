import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileContent } from '../files'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'polycode-files-'))
  tempDirs.push(dir)
  const filePath = join(dir, name)
  writeFileSync(filePath, content)
  return filePath
}

describe('readFileContent', () => {
  it('returns text files as text', () => {
    expect(readFileContent(tempFile('notes.txt', 'hello'))).toEqual({
      content: 'hello',
      truncated: false,
    })
  })

  it('returns raster images as typed data URLs instead of decoded binary', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])

    expect(readFileContent(tempFile('preview.PNG', bytes))).toEqual({
      content: '',
      truncated: false,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    })
  })
})
