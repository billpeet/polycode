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

function isEntryDirectory(entry: fs.Dirent, fullPath: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false

  try {
    return fs.statSync(fullPath).isDirectory()
  } catch {
    return false
  }
}

function shouldSkipEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) return IGNORED_DIRS.has(name)
  return name.startsWith('.') && !name.startsWith('.env')
}

export function listDirectory(dirPath: string): FileEntry[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const result: FileEntry[] = []

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const isDirectory = isEntryDirectory(entry, fullPath)
      if (shouldSkipEntry(entry.name, isDirectory)) continue

      result.push({
        name: entry.name,
        path: fullPath,
        isDirectory,
        isSymlink: entry.isSymbolicLink(),
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
  const visitedDirs = new Set<string>()

  function walk(dirPath: string): void {
    if (results.length >= MAX_SEARCH_FILES) return

    try {
      const realPath = fs.realpathSync(dirPath)
      if (visitedDirs.has(realPath)) return
      visitedDirs.add(realPath)
    } catch {
      return
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        if (results.length >= MAX_SEARCH_FILES) break

        const fullPath = path.join(dirPath, entry.name)
        const isDirectory = isEntryDirectory(entry, fullPath)
        if (shouldSkipEntry(entry.name, isDirectory)) continue

        if (isDirectory) {
          const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
          results.push({
            path: fullPath,
            relativePath,
            name: entry.name,
            isDirectory: true,
            isSymlink: entry.isSymbolicLink(),
          })
          walk(fullPath)
        } else {
          const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
          results.push({
            path: fullPath,
            relativePath,
            name: entry.name,
            isSymlink: entry.isSymbolicLink(),
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
