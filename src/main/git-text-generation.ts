import { createHash } from 'crypto'
import { simpleQuery } from './claude-sdk'

export interface CommitMessageContext {
  branch: string | null
  changeSummary: string
  patch: string
  messagesContext?: string
}

export interface GeneratedCommitMessage {
  subject: string
  body: string
}

export interface PullRequestTextContext {
  sourceBranch: string | null
  targetBranch: string
  baseRef: string
  commitSummary: string
  changeSummary: string
  patch: string
}

export interface GeneratedPullRequestText {
  title: string
  description: string
}

const COMMIT_SUBJECT_FALLBACK = 'Update project files'
const PR_TITLE_FALLBACK = 'Update project files'
const BRANCH_NAME_FALLBACK = 'feature/update'

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[truncated]`
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^subject\s*:\s*/i, '')
    .trim() ?? ''
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, '').trim()
  if (!withoutTrailingPeriod) return COMMIT_SUBJECT_FALLBACK
  if (withoutTrailingPeriod.length <= 72) return withoutTrailingPeriod
  return withoutTrailingPeriod.slice(0, 72).trimEnd()
}

export function formatCommitMessage(message: GeneratedCommitMessage): string {
  const subject = sanitizeCommitSubject(message.subject)
  const body = message.body.trim()
  return body ? `${subject}\n\n${body}` : subject
}

export function sanitizePullRequestTitle(raw: string): string {
  const singleLine = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^(pull request|pr)?\s*title\s*:\s*/i, '')
    .trim() ?? ''
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, '').trim()
  if (!withoutTrailingPeriod) return PR_TITLE_FALLBACK
  if (withoutTrailingPeriod.length <= 90) return withoutTrailingPeriod
  return withoutTrailingPeriod.slice(0, 90).trimEnd()
}

export function formatPullRequestText(text: GeneratedPullRequestText): GeneratedPullRequestText {
  return {
    title: sanitizePullRequestTitle(text.title),
    description: text.description.trim(),
  }
}

/** Coerce arbitrary text into a valid, conventional-looking git branch name. */
export function sanitizeBranchName(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? ''
  let name = firstLine
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^branch(\s*name)?\s*:\s*/i, '')
    .trim()
    .toLowerCase()
    // Keep only branch-safe characters; everything else becomes a hyphen.
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    // git refs can't begin or end with separators, and can't end with ".lock".
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .replace(/\.lock(\/|$)/g, '$1')

  if (!name) return BRANCH_NAME_FALLBACK
  if (name.length > 60) name = name.slice(0, 60).replace(/[-/.]+$/g, '')
  return name || BRANCH_NAME_FALLBACK
}

export function buildCommitMessagePrompt(context: CommitMessageContext): string {
  const sections = [
    'You write concise git commit messages.',
    'Return only a JSON object with keys: subject, body.',
    'Rules:',
    '- subject must use conventional commit style when appropriate, for example feat:, fix:, refactor:, docs:, test:, chore:',
    '- subject must be imperative, <= 72 characters, and have no trailing period',
    '- body must be an empty string or short markdown bullet points',
    '- describe the primary user-visible or developer-visible change',
    '- do not mention truncation unless it materially affects the summary',
    '',
    `Branch: ${context.branch ?? '(detached)'}`,
    '',
    'Changed files:',
    limitSection(context.changeSummary, 8_000),
    '',
    'Patch:',
    '```diff',
    limitSection(context.patch, 40_000),
    '```',
  ]

  const extra = context.messagesContext?.trim()
  if (extra) {
    sections.push('', 'Additional context:', limitSection(extra, 4_000))
  }

  return sections.join('\n')
}

export function buildPullRequestTextPrompt(context: PullRequestTextContext): string {
  const sections = [
    'You write clear pull request titles and descriptions.',
    'Return only a JSON object with keys: title, description.',
    'Rules:',
    '- title must be concise, <= 90 characters, and have no trailing period',
    '- description must be markdown',
    '- description should start with "## Summary" followed by short bullet points',
    '- include "## Notes" only for migrations, breaking changes, configuration, or operational caveats evident in the diff',
    '- do not claim tests were run unless the provided context explicitly says so',
    '- do not mention AI, prompts, or truncation unless truncation materially affects confidence',
    '- describe the branch changes relative to the target branch',
    '',
    `Source branch: ${context.sourceBranch ?? '(detached)'}`,
    `Target branch: ${context.targetBranch}`,
    `Base ref: ${context.baseRef}`,
    '',
    'Commits on source branch:',
    limitSection(context.commitSummary || '(none)', 8_000),
    '',
    'Changed files:',
    limitSection(context.changeSummary, 8_000),
    '',
    'Patch:',
    '```diff',
    limitSection(context.patch, 40_000),
    '```',
  ]

  return sections.join('\n')
}

export function buildBranchNamePrompt(context: CommitMessageContext): string {
  const sections = [
    'You generate a short git branch name for a set of code changes.',
    'Return only a JSON object with a single key: branch.',
    'Rules:',
    '- branch must be lowercase kebab-case',
    '- branch should start with a conventional prefix followed by a slash: feature/, fix/, chore/, refactor/, or docs/',
    '- branch must be <= 50 characters and contain only letters, numbers, hyphens, and at most one slash',
    '- no spaces, no trailing slash, no special characters',
    '- describe the primary change concisely',
    '',
    `Current branch: ${context.branch ?? '(detached)'}`,
    '',
    'Changed files:',
    limitSection(context.changeSummary, 8_000),
    '',
    'Patch:',
    '```diff',
    limitSection(context.patch, 20_000),
    '```',
  ]

  return sections.join('\n')
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  const fenceMatch = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenceMatch?.[1]?.trim() ?? trimmed
}

function findFirstJsonObject(value: string): string | null {
  const start = value.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < value.length; i++) {
    const char = value[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return value.slice(start, i + 1)
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseJsonCommitMessage(raw: string): GeneratedCommitMessage | null {
  const stripped = stripCodeFence(raw)
  const candidates = [stripped, findFirstJsonObject(stripped)].filter((value): value is string => !!value)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (!isRecord(parsed) || typeof parsed.subject !== 'string') continue
      return {
        subject: parsed.subject,
        body: typeof parsed.body === 'string' ? parsed.body : '',
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

function parseJsonPullRequestText(raw: string): GeneratedPullRequestText | null {
  const stripped = stripCodeFence(raw)
  const candidates = [stripped, findFirstJsonObject(stripped)].filter((value): value is string => !!value)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (!isRecord(parsed) || typeof parsed.title !== 'string') continue
      return {
        title: parsed.title,
        description: typeof parsed.description === 'string' ? parsed.description : '',
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

function parseJsonBranchName(raw: string): string | null {
  const stripped = stripCodeFence(raw)
  const candidates = [stripped, findFirstJsonObject(stripped)].filter((value): value is string => !!value)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isRecord(parsed) && typeof parsed.branch === 'string') return parsed.branch
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

export function parseBranchNameResponse(raw: string): string {
  return parseJsonBranchName(raw) ?? raw
}

function parseTextCommitMessage(raw: string): GeneratedCommitMessage {
  const stripped = stripCodeFence(raw)
    .replace(/^commit message\s*:\s*/i, '')
    .trim()
  const lines = stripped.split(/\r?\n/g)
  const firstLineIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstLineIndex === -1) {
    return { subject: COMMIT_SUBJECT_FALLBACK, body: '' }
  }

  const subject = lines[firstLineIndex]!.replace(/^[-*]\s*/, '').trim()
  const body = lines.slice(firstLineIndex + 1).join('\n').trim()
  return { subject, body }
}

function parseTextPullRequestText(raw: string): GeneratedPullRequestText {
  const stripped = stripCodeFence(raw)
    .replace(/^(pull request|pr)\s*:\s*/i, '')
    .trim()
  const lines = stripped.split(/\r?\n/g)
  const firstLineIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstLineIndex === -1) {
    return { title: PR_TITLE_FALLBACK, description: '' }
  }

  const title = lines[firstLineIndex]!
    .replace(/^[-*]\s*/, '')
    .replace(/^(pull request|pr)?\s*title\s*:\s*/i, '')
    .trim()
  const description = lines.slice(firstLineIndex + 1).join('\n').trim()
  return { title, description }
}

export function parseCommitMessageResponse(raw: string): GeneratedCommitMessage {
  return parseJsonCommitMessage(raw) ?? parseTextCommitMessage(raw)
}

export function parsePullRequestTextResponse(raw: string): GeneratedPullRequestText {
  return parseJsonPullRequestText(raw) ?? parseTextPullRequestText(raw)
}

export function getCommitMessageContextHash(context: CommitMessageContext): string {
  return createHash('sha256')
    .update(context.branch ?? '')
    .update('\0')
    .update(context.changeSummary)
    .update('\0')
    .update(context.patch)
    .update('\0')
    .update(context.messagesContext ?? '')
    .digest('hex')
}

export function getPullRequestTextContextHash(context: PullRequestTextContext): string {
  return createHash('sha256')
    .update(context.sourceBranch ?? '')
    .update('\0')
    .update(context.targetBranch)
    .update('\0')
    .update(context.baseRef)
    .update('\0')
    .update(context.commitSummary)
    .update('\0')
    .update(context.changeSummary)
    .update('\0')
    .update(context.patch)
    .digest('hex')
}

export async function generateCommitMessageFromContext(
  context: CommitMessageContext,
  query: (prompt: string) => Promise<string> = simpleQuery,
): Promise<string> {
  const raw = await query(buildCommitMessagePrompt(context))
  return formatCommitMessage(parseCommitMessageResponse(raw))
}

export async function generatePullRequestTextFromContext(
  context: PullRequestTextContext,
  query: (prompt: string) => Promise<string> = simpleQuery,
): Promise<GeneratedPullRequestText> {
  const raw = await query(buildPullRequestTextPrompt(context))
  return formatPullRequestText(parsePullRequestTextResponse(raw))
}

export async function generateBranchNameFromContext(
  context: CommitMessageContext,
  query: (prompt: string) => Promise<string> = simpleQuery,
): Promise<string> {
  const raw = await query(buildBranchNamePrompt(context))
  return sanitizeBranchName(parseBranchNameResponse(raw))
}
