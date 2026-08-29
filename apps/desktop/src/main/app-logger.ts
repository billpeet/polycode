import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { inspect } from 'util'
import { recordLog } from './observability'

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
type LogSource = 'main' | 'renderer'

export interface RendererLogPayload {
  source: LogSource
  level: LogLevel
  timestamp: string
  messages: string[]
}

interface PendingLogLine {
  timestamp: string
  line: string
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

let installed = false
const pendingLines: PendingLogLine[] = []
let flushTimer: NodeJS.Timeout | null = null
let flushing = false

const LOG_FLUSH_INTERVAL_MS = 100
const LOG_FLUSH_BATCH_SIZE = 250
export const MAX_PENDING_LOG_LINES = 5_000

function formatLocalDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function logsDir(): string {
  try {
    return path.join(app.getPath('userData'), 'logs')
  } catch {
    return path.join(process.cwd(), 'logs')
  }
}

function appLogFilePath(date = new Date()): string {
  return path.join(logsDir(), `app-${formatLocalDay(date)}.log`)
}

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`
  }

  if (typeof arg === 'string') {
    return arg
  }

  return inspect(arg, {
    depth: 6,
    breakLength: 120,
    maxArrayLength: 50,
    maxStringLength: 10_000,
  })
}

function appendLogLine(source: LogSource, level: LogLevel, timestamp: string, messages: string[]): void {
  pendingLines.push({ timestamp, line: `[${timestamp}] [${source}] [${level}] ${messages.join(' ')}\n` })
  if (pendingLines.length > MAX_PENDING_LOG_LINES) {
    pendingLines.splice(0, pendingLines.length - MAX_PENDING_LOG_LINES)
  }
  recordLog(level, messages.join(' '), { 'polycode.process.type': source })
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer || flushing) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPendingLines()
  }, LOG_FLUSH_INTERVAL_MS)
  flushTimer.unref()
}

async function flushPendingLines(): Promise<void> {
  if (flushing || pendingLines.length === 0) return
  flushing = true
  const lines = pendingLines.splice(0, LOG_FLUSH_BATCH_SIZE)

  try {
    const dir = logsDir()
    await fs.promises.mkdir(dir, { recursive: true })
    const linesByFile = new Map<string, string[]>()
    for (const entry of lines) {
      const file = appLogFilePath(new Date(entry.timestamp))
      const fileLines = linesByFile.get(file) ?? []
      fileLines.push(entry.line)
      linesByFile.set(file, fileLines)
    }
    await Promise.all(
      [...linesByFile].map(([file, fileLines]) => fs.promises.appendFile(file, fileLines.join(''), 'utf8'))
    )
  } catch (err) {
    originalConsole.error('[logger] Failed to write app log file', err)
  } finally {
    flushing = false
    if (pendingLines.length > 0) scheduleFlush()
  }
}

export function flushAppLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingLines.length === 0) return

  try {
    const dir = logsDir()
    fs.mkdirSync(dir, { recursive: true })
    const linesByFile = new Map<string, string[]>()
    for (const entry of pendingLines.splice(0)) {
      const file = appLogFilePath(new Date(entry.timestamp))
      const fileLines = linesByFile.get(file) ?? []
      fileLines.push(entry.line)
      linesByFile.set(file, fileLines)
    }
    for (const [file, fileLines] of linesByFile) {
      fs.appendFileSync(file, fileLines.join(''), 'utf8')
    }
  } catch (err) {
    originalConsole.error('[logger] Failed to flush app log file', err)
  }
}

export function writeMainLog(level: LogLevel, ...args: unknown[]): void {
  appendLogLine('main', level, new Date().toISOString(), args.map(serializeArg))
}

export function writeFatalLog(kind: string, error: unknown): void {
  writeMainLog('error', `[fatal] ${kind}`, error)
}

export function installAppLogger(): void {
  if (installed) return
  installed = true

  const levels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug']

  for (const level of levels) {
    console[level] = (...args: unknown[]) => {
      originalConsole[level](...args)
      appendLogLine('main', level, new Date().toISOString(), args.map(serializeArg))
    }
  }
}

export function writeRendererLog(payload: RendererLogPayload): void {
  appendLogLine(payload.source, payload.level, payload.timestamp, payload.messages)
}

export function getAppLogFilePath(date = new Date()): string {
  return appLogFilePath(date)
}

export function getLogsDirPath(): string {
  return logsDir()
}
