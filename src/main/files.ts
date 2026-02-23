import * as fs from 'node:fs'
import * as path from 'node:path'
import { FileEntry, SearchableFile } from '../shared/types'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.vite',
  '__pycache__',
  '.cache',
  'dist',
  'build',
  'out',
  '.vscode',
  '.idea',
  'coverage',
  '.nyc_output',
])

const MAX_FILE_SIZE = 1024 * 1024 // 1MB

export function listDirectory(dirPath: string): FileEntry[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const result: FileEntry[] = []

    for (const entry of entries) {
      // Skip hidden files and ignored directories
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue

      const fullPath = path.join(dirPath, entry.name)
      result.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
      })
    }

    // Sort: directories first, then alphabetically
    return result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  } catch {
    return []
  }
}

const MAX_SEARCH_FILES = 5000

/**
 * Recursively list all files in a directory for fuzzy search.
 * Returns paths relative to the root directory.
 */
export function listAllFiles(rootPath: string): SearchableFile[] {
  const results: SearchableFile[] = []

  function walk(dirPath: string): void {
    if (results.length >= MAX_SEARCH_FILES) return

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_FILES) break

        // Skip hidden files (except .env-like files)
        if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) continue

        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          // Skip ignored directories
          if (IGNORED_DIRS.has(entry.name)) continue
          const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
          results.push({
            path: fullPath,
            relativePath,
            name: entry.name,
            isDirectory: true,
          })
          walk(fullPath)
        } else {
          const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
          results.push({
            path: fullPath,
            relativePath,
            name: entry.name,
          })
        }
      }
    } catch {
      // Permission denied or other error - skip this directory
    }
  }

  walk(rootPath)
  return results
}

export function readFileContent(filePath: string): { content: string; truncated: boolean } | null {
  try {
    const stats = fs.statSync(filePath)
    if (stats.size > MAX_FILE_SIZE) {
      // Return first 1MB for large files
      const fd = fs.openSync(filePath, 'r')
      const buffer = Buffer.alloc(MAX_FILE_SIZE)
      fs.readSync(fd, buffer, 0, MAX_FILE_SIZE, 0)
      fs.closeSync(fd)
      return { content: buffer.toString('utf8'), truncated: true }
    }
    return { content: fs.readFileSync(filePath, 'utf8'), truncated: false }
  } catch {
    return null
  }
}
