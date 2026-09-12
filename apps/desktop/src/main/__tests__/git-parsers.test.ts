import { describe, expect, it } from 'vitest'
import { parseCommitLog, parseNameStatus, parsePorcelainBranchHeader, parsePorcelainStatus, splitPorcelainBranchOutput } from '../git-parsers'

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

  it('parses every form of the porcelain --branch header', () => {
    expect(parsePorcelainBranchHeader('## main')).toEqual({ branch: 'main', upstream: null, ahead: 0, behind: 0 })
    expect(parsePorcelainBranchHeader('## main...origin/main')).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 })
    expect(parsePorcelainBranchHeader('## feature/x...origin/feature/x [ahead 2, behind 1]')).toEqual({ branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1 })
    expect(parsePorcelainBranchHeader('## main...origin/main [ahead 3]')).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 3, behind: 0 })
    expect(parsePorcelainBranchHeader('## main...origin/main [gone]')).toEqual({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 })
    // A branch cut from master keeps master as @{u}: reported as the upstream, and it is the
    // caller's `origin/<branch>` comparison that decides "has upstream", exactly as before.
    expect(parsePorcelainBranchHeader('## perf/x...origin/master')).toEqual({ branch: 'perf/x', upstream: 'origin/master', ahead: 0, behind: 0 })
    // Detached and unborn match what `rev-parse --abbrev-ref HEAD` used to yield: 'HEAD'.
    expect(parsePorcelainBranchHeader('## HEAD (no branch)')).toEqual({ branch: 'HEAD', upstream: null, ahead: 0, behind: 0 })
    expect(parsePorcelainBranchHeader('## No commits yet on main')).toEqual({ branch: 'HEAD', upstream: null, ahead: 0, behind: 0 })
    expect(parsePorcelainBranchHeader('')).toEqual({ branch: 'HEAD', upstream: null, ahead: 0, behind: 0 })
    // A branch name containing "[" does not confuse the bracket split.
    expect(parsePorcelainBranchHeader('## release[1]...origin/release[1] [behind 4]')).toEqual({ branch: 'release[1]', upstream: 'origin/release[1]', ahead: 0, behind: 4 })
  })

  it('splits the --branch header from the file rows and leaves headerless output alone', () => {
    expect(splitPorcelainBranchOutput('## main...origin/main\nM  a.ts\n?? b.ts\n')).toEqual({ header: '## main...origin/main', body: 'M  a.ts\n?? b.ts\n' })
    expect(splitPorcelainBranchOutput('## main')).toEqual({ header: '## main', body: '' })
    expect(splitPorcelainBranchOutput('## main\r\n M x.ts')).toEqual({ header: '## main', body: ' M x.ts' })
    expect(splitPorcelainBranchOutput('M  a.ts\n')).toEqual({ header: '', body: 'M  a.ts\n' })
    expect(splitPorcelainBranchOutput('')).toEqual({ header: '', body: '' })
    expect(parsePorcelainStatus(splitPorcelainBranchOutput('## main\n?? "caf\\303\\251.txt"').body)).toEqual([{ status: '?', path: 'café.txt', staged: false }])
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
