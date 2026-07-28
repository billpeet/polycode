import type { CommitLogEntry } from '../shared/types'
import type { GitFileChange } from './git'

const FILE_STATUSES = ['M', 'A', 'D', 'R', 'U', '?'] as const

function isFileStatus(value: string): value is GitFileChange['status'] {
  return FILE_STATUSES.includes(value as GitFileChange['status'])
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
      if (newPath) files.push({ status, path: newPath, oldPath, staged: false })
      continue
    }
    const path = parts[1]
    if (path) files.push({ status, path, staged: false })
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
      const arrowIndex = rest.indexOf(' -> ')
      files.push({
        status: 'R',
        path: arrowIndex === -1 ? rest : rest.slice(arrowIndex + 4),
        oldPath: arrowIndex === -1 ? '' : rest.slice(0, arrowIndex),
        staged: stagedCode === 'R',
      })
      continue
    }

    if (isFileStatus(stagedCode) && stagedCode !== '?') {
      files.push({ status: stagedCode, path: rest, staged: true })
    }
    if (isFileStatus(unstagedCode) && unstagedCode !== '?') {
      files.push({ status: unstagedCode, path: rest, staged: false })
    }
    if (stagedCode === '?' && unstagedCode === '?') {
      files.push({ status: '?', path: rest, staged: false })
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
