import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'

const ATTACHMENT_DIR_NAME = 'polycode-attachments'

/** Get or create the temp attachments directory */
export function getAttachmentDir(): string {
  const tempDir = path.join(os.tmpdir(), ATTACHMENT_DIR_NAME)
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  return tempDir
}

/** Save attachment from base64 data URL to temp file */
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The per-thread directory, or an error. `threadId` reaches here from a client — a
 * remote session may drive `attachments:*` — and it becomes a path segment under a
 * directory that `cleanup` deletes recursively. A strict shape check plus a containment
 * check means no id can name anything outside the attachment dir.
 */
export function resolveThreadDir(threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error('Invalid thread id')
  const attachDir = getAttachmentDir()
  const threadDir = path.resolve(attachDir, threadId)
  if (!threadDir.startsWith(attachDir + path.sep)) throw new Error('Invalid thread id')
  return threadDir
}

export function saveAttachment(
  dataUrl: string,
  filename: string,
  threadId: string
): { tempPath: string; id: string } {
  const threadDir = resolveThreadDir(threadId)

  if (!fs.existsSync(threadDir)) {
    fs.mkdirSync(threadDir, { recursive: true })
  }

  // Parse data URL: data:image/png;base64,iVBORw0KGgo...
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) {
    throw new Error('Invalid data URL format')
  }

  const base64Data = matches[2]
  const buffer = Buffer.from(base64Data, 'base64')

  // Generate unique filename to avoid collisions
  const id = randomUUID()
  const ext = path.extname(filename) || '.bin'
  const safeFilename = `${id}${ext}`
  const tempPath = path.join(threadDir, safeFilename)

  fs.writeFileSync(tempPath, buffer)

  return { tempPath, id }
}

/** Save attachment from file path (for file picker / drag-drop with path) */
export function copyAttachmentFromPath(
  sourcePath: string,
  threadId: string
): { tempPath: string; id: string } {
  const attachDir = getAttachmentDir()
  const threadDir = path.join(attachDir, threadId)

  if (!fs.existsSync(threadDir)) {
    fs.mkdirSync(threadDir, { recursive: true })
  }

  const id = randomUUID()
  const ext = path.extname(sourcePath) || '.bin'
  const safeFilename = `${id}${ext}`
  const tempPath = path.join(threadDir, safeFilename)

  fs.copyFileSync(sourcePath, tempPath)

  return { tempPath, id }
}

/** Clean up temp files for a specific thread */
export function cleanupThreadAttachments(threadId: string): void {
  const threadDir = resolveThreadDir(threadId)
  if (fs.existsSync(threadDir)) {
    fs.rmSync(threadDir, { recursive: true, force: true })
  }
}

/** Clean up all temp attachments (called on app exit) */
export function cleanupAllAttachments(): void {
  const attachDir = path.join(os.tmpdir(), ATTACHMENT_DIR_NAME)
  if (fs.existsSync(attachDir)) {
    fs.rmSync(attachDir, { recursive: true, force: true })
  }
}

/** Get file info for validation */
export function getFileInfo(filePath: string): { size: number; mimeType: string } | null {
  try {
    const stats = fs.statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()

    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
    }

    return {
      size: stats.size,
      mimeType: mimeMap[ext] || 'application/octet-stream',
    }
  } catch {
    return null
  }
}
