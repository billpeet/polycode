import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { ThreadLogEntry } from '../shared/types'

function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function logFilePath(threadId: string): string {
  return path.join(logsDir(), `${threadId}.log`)
}

export function logThreadEvent(threadId: string, entry: ThreadLogEntry): void {
  try {
    const dir = logsDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.appendFileSync(logFilePath(threadId), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // Logging is a side effect — never throw
  }
}

export function getThreadLogs(threadId: string): ThreadLogEntry[] {
  try {
    const filePath = logFilePath(threadId)
    if (!fs.existsSync(filePath)) return []
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ThreadLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is ThreadLogEntry => entry !== null)
  } catch {
    return []
  }
}
