import { watch, readFileSync, readdirSync, existsSync, mkdirSync, statSync, FSWatcher } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { BrowserWindow } from 'electron'

const PLANS_DIR = join(homedir(), '.claude', 'plans')

let watcher: FSWatcher | null = null

export interface PlanFile {
  name: string
  path: string
  modifiedAt: number
}

export function listPlanFiles(): PlanFile[] {
  if (!existsSync(PLANS_DIR)) return []
  try {
    return readdirSync(PLANS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const fullPath = join(PLANS_DIR, f)
        const stat = statSync(fullPath)
        return { name: f, path: fullPath, modifiedAt: stat.mtimeMs }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
  } catch {
    return []
  }
}

export function readPlanFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function startPlanWatcher(win: BrowserWindow): void {
  if (!existsSync(PLANS_DIR)) {
    mkdirSync(PLANS_DIR, { recursive: true })
  }

  // Per-filename debounce to avoid dropping events when multiple plans are written simultaneously
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  watcher = watch(PLANS_DIR, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.md')) return

    const existing = debounceTimers.get(filename)
    if (existing) clearTimeout(existing)
    debounceTimers.set(filename, setTimeout(() => {
      debounceTimers.delete(filename)
      const fullPath = join(PLANS_DIR, filename)
      if (!existsSync(fullPath)) return
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const stat = statSync(fullPath)
        win.webContents.send('plan-file:changed', {
          name: filename,
          path: fullPath,
          content,
          modifiedAt: stat.mtimeMs,
        })
      } catch {
        // File may have been deleted between check and read
      }
    }, 200))
  })
}

export function stopPlanWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}
