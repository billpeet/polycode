import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ClaudeProject, ClaudeSession } from '../shared/types'

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  content?: string
  is_error?: boolean
  tool_use_id?: string
}

interface JsonlRecord {
  type: 'user' | 'assistant' | 'queue-operation'
  sessionId: string
  slug?: string
  timestamp: string
  uuid: string
  parentUuid: string | null
  message?: {
    role: 'user' | 'assistant'
    content: string | ContentBlock[]
    model?: string
  }
  toolUseResult?: string
}

export interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

function decodeProjectPath(encoded: string): string {
  // Claude Code encodes paths by replacing path separators with dashes
  // e.g., "C--Users-marti-source-polycode" -> "C:\Users\marti\source\polycode" (Windows)
  // or "/home/user/project" -> "-home-user-project" (Unix)

  if (process.platform === 'win32') {
    // Windows: "C--Users-marti" -> "C:\Users\marti"
    const parts = encoded.split('-')
    if (parts.length >= 2 && parts[0].length === 1 && parts[1] === '') {
      // Starts with drive letter like "C--"
      const drive = parts[0]
      const rest = parts.slice(2).join('\\')
      return `${drive}:\\${rest}`
    }
  }

  // Unix-style: replace leading dash and internal dashes with /
  if (encoded.startsWith('-')) {
    return '/' + encoded.slice(1).replace(/-/g, '/')
  }

  return encoded.replace(/-/g, path.sep)
}

export function listClaudeProjects(): ClaudeProject[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return []
  }

  const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
  const projects: ClaudeProject[] = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const projectDir = path.join(CLAUDE_PROJECTS_DIR, entry.name)
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))

      if (jsonlFiles.length > 0) {
        projects.push({
          encodedPath: entry.name,
          decodedPath: decodeProjectPath(entry.name),
          sessions: [] // Populated on demand
        })
      }
    }
  }

  return projects
}

export function listClaudeSessions(encodedProjectPath: string): ClaudeSession[] {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedProjectPath)

  if (!fs.existsSync(projectDir)) {
    return []
  }

  const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
  const sessions: ClaudeSession[] = []

  for (const file of jsonlFiles) {
    const filePath = path.join(projectDir, file)
    const sessionInfo = getSessionInfo(filePath)
    if (sessionInfo) {
      sessions.push(sessionInfo)
    }
  }

  // Sort by last activity descending
  sessions.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())

  return sessions
}

function getSessionInfo(filePath: string): ClaudeSession | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)

    if (lines.length === 0) return null

    let sessionId = ''
    let slug: string | null = null
    let firstUserMessage = ''
    let lastTimestamp = ''
    let messageCount = 0

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as JsonlRecord

        if (record.type === 'queue-operation') continue

        if (!sessionId && record.sessionId) {
          sessionId = record.sessionId
        }

        if (!slug && record.slug) {
          slug = record.slug
        }

        if (record.timestamp) {
          lastTimestamp = record.timestamp
        }

        if (record.type === 'user' || record.type === 'assistant') {
          messageCount++
        }

        // Get first user message content for preview
        if (!firstUserMessage && record.type === 'user' && record.message) {
          const content = record.message.content
          if (typeof content === 'string') {
            firstUserMessage = content
          } else if (Array.isArray(content)) {
            // Find first text or tool_result content
            for (const block of content) {
              if (block.type === 'tool_result' && typeof block.content === 'string') {
                // Skip tool results for first message preview
                continue
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (!sessionId) return null

    return {
      sessionId,
      slug,
      filePath,
      firstMessage: firstUserMessage.slice(0, 100) + (firstUserMessage.length > 100 ? '...' : ''),
      messageCount,
      lastActivity: lastTimestamp
    }
  } catch {
    return null
  }
}

export function parseSessionMessages(filePath: string): ParsedMessage[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)
  const messages: ParsedMessage[] = []
  const seenContentKeys = new Set<string>()

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as JsonlRecord

      // Skip queue operations
      if (record.type === 'queue-operation') continue

      // Skip if no message
      if (!record.message) continue

      const msgContent = record.message.content

      // Handle string content (simple user message)
      if (typeof msgContent === 'string') {
        const key = `${record.uuid}-text`
        if (seenContentKeys.has(key)) continue
        seenContentKeys.add(key)

        if (msgContent.trim()) {
          messages.push({
            role: record.message.role,
            content: msgContent,
            timestamp: record.timestamp,
            metadata: { uuid: record.uuid }
          })
        }
        continue
      }

      // Handle array content - process each block separately
      for (const block of msgContent) {
        if (block.type === 'text' && block.text?.trim()) {
          // Text block - regular message
          const key = `${record.uuid}-text-${block.text.slice(0, 50)}`
          if (seenContentKeys.has(key)) continue
          seenContentKeys.add(key)

          messages.push({
            role: record.message.role,
            content: block.text,
            timestamp: record.timestamp,
            metadata: {
              uuid: record.uuid,
              model: record.message.model
            }
          })
        } else if (block.type === 'tool_use' && block.name && block.id) {
          // Tool call block - needs special metadata
          const key = `${record.uuid}-tool_use-${block.id}`
          if (seenContentKeys.has(key)) continue
          seenContentKeys.add(key)

          messages.push({
            role: 'assistant',
            content: block.name,
            timestamp: record.timestamp,
            metadata: {
              type: 'tool_call',
              name: block.name,
              id: block.id,
              input: block.input
            }
          })
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          // Tool result block - needs special metadata
          const key = `${record.uuid}-tool_result-${block.tool_use_id}`
          if (seenContentKeys.has(key)) continue
          seenContentKeys.add(key)

          messages.push({
            role: 'user',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            timestamp: record.timestamp,
            metadata: {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              is_error: block.is_error ?? false,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
            }
          })
        }
        // Skip thinking blocks - internal reasoning
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}

export function getSessionFilePath(encodedProjectPath: string, sessionId: string): string | null {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedProjectPath)
  const filePath = path.join(projectDir, `${sessionId}.jsonl`)

  if (fs.existsSync(filePath)) {
    return filePath
  }

  // Also check for agent- prefixed files
  const agentPath = path.join(projectDir, `agent-${sessionId}.jsonl`)
  if (fs.existsSync(agentPath)) {
    return agentPath
  }

  return null
}
