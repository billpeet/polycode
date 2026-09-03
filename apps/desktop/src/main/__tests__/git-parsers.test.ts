import { describe, expect, it } from 'vitest'
import { parseCommitLog, parseNameStatus, parsePorcelainStatus } from '../git-parsers'

describe('git parsers', () => {
  it('parses name-status including scored renames and ignores malformed rows', () => {
    expect(parseNameStatus('M\tsrc/a.ts\nR100\told.ts\tnew.ts\nX\tignored.ts\nR050\tmissing.ts')).toEqual([
      { status: 'M', path: 'src/a.ts', staged: false },
      { status: 'R', path: 'new.ts', oldPath: 'old.ts', staged: false },
    ])
  })

  it('parses staged, unstaged, untracked, and renamed porcelain rows', () => {
    expect(parsePorcelainStatus('M  staged.ts\n M unstaged.ts\nMM both.ts\n?? new.ts\nR  old.ts -> new.ts')).toEqual([
      { status: 'M', path: 'staged.ts', staged: true },
      { status: 'M', path: 'unstaged.ts', staged: false },
      { status: 'M', path: 'both.ts', staged: true },
      { status: 'M', path: 'both.ts', staged: false },
      { status: '?', path: 'new.ts', staged: false },
      { status: 'R', path: 'new.ts', oldPath: 'old.ts', staged: true },
    ])
  })

  it('decodes Git-quoted paths from porcelain and name-status output', () => {
    expect(parsePorcelainStatus(' M "AutoCad Utils.csproj"\nR  "old -> project.csproj" -> "new project.csproj"\n?? "caf\\303\\251.txt"')).toEqual([
      { status: 'M', path: 'AutoCad Utils.csproj', staged: false },
      { status: 'R', path: 'new project.csproj', oldPath: 'old -> project.csproj', staged: true },
      { status: '?', path: 'café.txt', staged: false },
    ])

    expect(parseNameStatus('M\t"AutoCad Utils.csproj"\nR100\t"old project.csproj"\t"new project.csproj"')).toEqual([
      { status: 'M', path: 'AutoCad Utils.csproj', staged: false },
      { status: 'R', path: 'new project.csproj', oldPath: 'old project.csproj', staged: false },
    ])
  })

  it('parses commit records including merges and tabs in subjects', () => {
    const line = 'abcdef\tabc123\tAda\tada@example.com\t2026-07-29T09:00:00Z\tparent1 parent2\tSubject\twith tab'
    expect(parseCommitLog(`${line}\nmalformed`)).toEqual([{
      sha: 'abcdef',
      shortSha: 'abc123',
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      authorDate: '2026-07-29T09:00:00Z',
      parents: ['parent1', 'parent2'],
      subject: 'Subject\twith tab',
    }])
  })
})
