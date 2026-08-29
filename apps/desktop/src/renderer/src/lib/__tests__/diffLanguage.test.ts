import { describe, expect, it } from 'vitest'
import { diffLanguageFromPath } from '../diffLanguage'

describe('diffLanguageFromPath', () => {
  it('normalizes Windows paths before identifying a known filename', () => {
    expect(diffLanguageFromPath('api\\Dockerfile')).toBe('docker')
  })

  it('identifies known filenames in POSIX paths', () => {
    expect(diffLanguageFromPath('services/api/Makefile')).toBe('makefile')
  })

  it('maps .NET project files to XML', () => {
    expect(diffLanguageFromPath('src/App/App.csproj')).toBe('xml')
  })

  it('uses only the final extension of compound filenames', () => {
    expect(diffLanguageFromPath('src/button.test.tsx')).toBe('tsx')
  })

  it('uses canonical Shiki language IDs for common aliases', () => {
    expect(diffLanguageFromPath('scripts/setup.ps1')).toBe('powershell')
  })

  it.each([
    undefined,
    '',
    'LICENSE',
    '.gitignore',
    'src/example.not-a-shiki-language',
    'folder.with.dot\\README',
  ])('falls back to text for an unsupported path: %s', (filePath) => {
    expect(diffLanguageFromPath(filePath)).toBe('text')
  })
})
