import type { CommitLogEntry } from '../shared/types'
import type { GitFileChange } from './git'

const FILE_STATUSES = ['M', 'A', 'D', 'R', 'U', '?'] as const

function isFileStatus(value: string): value is GitFileChange['status'] {
  return FILE_STATUSES.includes(value as GitFileChange['status'])
}

/** Decode the C-style path quoting used by Git's human-readable output formats. */
function decodeGitPath(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') return value

  const bytes: number[] = []
  const escapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  }

  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index] ?? ''
    if (character !== '\\') {
      const codePoint = value.codePointAt(index)
      if (codePoint === undefined) continue
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint)))
      if (codePoint > 0xffff) index += 1
      continue
    }

    const escaped = value[++index] ?? ''
    if (escaped in escapes) {
      bytes.push(escapes[escaped]!)
      continue
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? '')) octal += value[++index]
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    bytes.push(...Buffer.from(escaped))
  }

  return Buffer.from(bytes).toString('utf8')
}

function splitPorcelainRename(value: string): [string, string] | null {
  let quoted = false
  let escaped = false
  for (let index = 0; index <= value.length - 4; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quoted && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && value.slice(index, index + 4) === ' -> ') {
      return [value.slice(0, index), value.slice(index + 4)]
    }
  }
  return null
}

export function parseNameStatus(output: string): GitFileChange[] {
  if (!output) return []
  const files: GitFileChange[] = []
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split('\t')
    const status = parts[0]?.[0] ?? ''
    if (!isFileStatus(status)) continue
    if (status === 'R') {
      const oldPath = parts[1]
      const newPath = parts[2]
      if (newPath) files.push({ status, path: decodeGitPath(newPath), oldPath: oldPath ? decodeGitPath(oldPath) : oldPath, staged: false })
      continue
    }
    const path = parts[1]
    if (path) files.push({ status, path: decodeGitPath(path), staged: false })
  }
  return files
}

export function parsePorcelainStatus(output: string): GitFileChange[] {
  const files: GitFileChange[] = []
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    if (line.length < 4) continue
    const stagedCode = line[0] ?? ''
    const unstagedCode = line[1] ?? ''
    const rest = line.slice(3).trimEnd()

    if (stagedCode === 'R' || unstagedCode === 'R') {
      const rename = splitPorcelainRename(rest)
      files.push({
        status: 'R',
        path: decodeGitPath(rename?.[1] ?? rest),
        oldPath: rename ? decodeGitPath(rename[0]) : '',
        staged: stagedCode === 'R',
      })
      continue
    }

    if (isFileStatus(stagedCode) && stagedCode !== '?') {
      files.push({ status: stagedCode, path: decodeGitPath(rest), staged: true })
    }
    if (isFileStatus(unstagedCode) && unstagedCode !== '?') {
      files.push({ status: unstagedCode, path: decodeGitPath(rest), staged: false })
    }
    if (stagedCode === '?' && unstagedCode === '?') {
      files.push({ status: '?', path: decodeGitPath(rest), staged: false })
    }
  }
  return files
}

export function parseCommitLog(output: string): CommitLogEntry[] {
  if (!output) return []
  const entries: CommitLogEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [sha, shortSha, authorName, authorEmail, authorDate, parentsRaw, ...subjectRest] = parts
    entries.push({
      sha,
      shortSha,
      authorName,
      authorEmail,
      authorDate,
      parents: parentsRaw ? parentsRaw.split(/\s+/).filter(Boolean) : [],
      subject: subjectRest.join('\t'),
    })
  }
  return entries
}
