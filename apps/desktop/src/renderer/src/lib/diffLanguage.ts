import { bundledLanguages } from 'shiki'
import type { BundledLanguage } from 'shiki'

const FILE_NAME_LANGUAGES: Record<string, BundledLanguage> = {
  dockerfile: 'docker',
  makefile: 'makefile',
}

const EXTENSION_LANGUAGES: Record<string, BundledLanguage> = {
  csproj: 'xml',
  fsproj: 'xml',
  props: 'xml',
  targets: 'xml',
  vbproj: 'xml',
  cs: 'csharp',
  h: 'c',
  hpp: 'cpp',
  js: 'javascript',
  jsx: 'jsx',
  md: 'markdown',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  sh: 'shellscript',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
}

/** Return only language IDs that @pierre/diffs can safely resolve through Shiki. */
export function diffLanguageFromPath(filePath: string | undefined): BundledLanguage | 'text' {
  if (!filePath) return 'text'

  const fileName = filePath.split(/[/\\]/).pop()?.toLowerCase()
  if (!fileName) return 'text'

  const fileNameLanguage = FILE_NAME_LANGUAGES[fileName]
  if (fileNameLanguage) return fileNameLanguage

  const finalDot = fileName.lastIndexOf('.')
  if (finalDot <= 0 || finalDot === fileName.length - 1) return 'text'

  const extension = fileName.slice(finalDot + 1)
  const language = EXTENSION_LANGUAGES[extension] ?? extension
  return language in bundledLanguages ? language as BundledLanguage : 'text'
}
