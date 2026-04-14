import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { inspect } from 'util'

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'
type LogSource = 'main' | 'renderer'

export interface RendererLogPayload {
  source: LogSource
  level: LogLevel
  timestamp: string
  messages: string[]
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}

let installed = false
let writeInProgress = false

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
  if (writeInProgress) return

  writeInProgress = true
  try {
    const dir = logsDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const line = `[${timestamp}] [${source}] [${level}] ${messages.join(' ')}\n`
    fs.appendFileSync(appLogFilePath(new Date(timestamp)), line, 'utf8')
  } catch (err) {
    originalConsole.error('[logger] Failed to write app log file', err)
  } finally {
    writeInProgress = false
  }
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
