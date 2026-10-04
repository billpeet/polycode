import { describe, expect, it } from 'vitest'
import type { Project, Thread } from '../types'
import { isUnifiedWatchedChannel, mergeUnifiedSources, normalizeGitUrl, readUnifiedSourceProjects, replaceUnifiedSources, type UnifiedSource, type UnifiedSourceProject } from '../unified'

describe('normalizeGitUrl', () => {
  it.each([
    ['https://github.com/Org/Repo.git', 'github.com/org/repo'],
    ['https://github.com/org/repo/', 'github.com/org/repo'],
    ['git@github.com:Org/Repo.git', 'github.com/org/repo'],
    ['ssh://git@github.com:22/org/repo', 'github.com/org/repo'],
    ['https://user:token@github.com/org/repo', 'github.com/org/repo'],
    ['github.com/org/repo', 'github.com/org/repo'],
    ['git@ssh.dev.azure.com:v3/Org/Project/Repo', 'dev.azure.com/org/project/_git/repo'],
    ['https://org@dev.azure.com/Org/Project/_git/Repo', 'dev.azure.com/org/project/_git/repo'],
    ['https://org.visualstudio.com/Project/_git/Repo', 'dev.azure.com/org/project/_git/repo'],
    ['https://org.visualstudio.com/DefaultCollection/Project/_git/Repo', 'dev.azure.com/org/project/_git/repo'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeGitUrl(input)).toBe(expected)
  })

  it('stays linear on a pathological run of slashes', () => {
    // Regression for a polynomial-time trailing-slash regex (CodeQL js/polynomial-redos).
    const hostile = `https://example.com/${'/'.repeat(200_000)}x`
    const startedAt = performance.now()
    normalizeGitUrl(hostile)
    normalizeGitUrl(`git@example.com:${'/'.repeat(200_000)}x`)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  it('strips surrounding slashes and a .git suffix in any case', () => {
    expect(normalizeGitUrl('https://github.com///org/repo.GIT')).toBe('github.com/org/repo')
    expect(normalizeGitUrl('https://github.com/org/repo///')).toBe('github.com/org/repo')
  })

  it('treats blank and missing URLs as having no identity', () => {
    expect(normalizeGitUrl(null)).toBeNull()
    expect(normalizeGitUrl('   ')).toBeNull()
  })
})

function project(id: string, name: string, gitUrl: string | null, updatedAt = '2026-01-01T00:00:00Z'): Project {
  return {
    id,
    name,
    git_url: gitUrl,
    favicon_path: null,
    allow_main_branch_commits: true,
    archived_at: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

function thread(id: string, updatedAt: string): Thread {
  return { id, updated_at: updatedAt } as Thread
}

function entry(p: Project, threads: Thread[] = []): UnifiedSourceProject {
  return { project: p, locations: [], pools: [], threads, archivedCount: 0, snoozedCount: 0 }
}

function source(sourceId: string, projects: UnifiedSourceProject[], status: UnifiedSource['status'] = 'ok'): UnifiedSource {
  return { sourceId, label: sourceId, status, error: null, projects, archivedProjects: [] }
}

describe('mergeUnifiedSources', () => {
  it('merges Projects with the same repository across sources, keeping each member', () => {
    const merged = mergeUnifiedSources([
      source('local', [entry(project('a', 'Polycode', 'https://github.com/x/polycode.git'))]),
      source('host-1', [entry(project('b', 'polycode', 'git@github.com:x/PolyCode'))]),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].repoKey).toBe('github.com/x/polycode')
    expect(merged[0].members.map((m) => [m.sourceId, m.project.id])).toEqual([['local', 'a'], ['host-1', 'b']])
  })

  it('never merges Projects without a Git URL, even with the same name', () => {
    const merged = mergeUnifiedSources([
      source('local', [entry(project('a', 'Scratch', null))]),
      source('host-1', [entry(project('a', 'Scratch', null))]),
    ])
    expect(merged.map((p) => p.key).sort()).toEqual(['host-1:a', 'local:a'])
  })

  it('skips unreachable sources', () => {
    const merged = mergeUnifiedSources([
      source('host-1', [entry(project('a', 'A', 'github.com/x/a'))], 'error'),
    ])
    expect(merged).toEqual([])
  })

  it('orders by latest Thread activity across members', () => {
    const merged = mergeUnifiedSources([
      source('local', [
        entry(project('a', 'Old', 'github.com/x/old'), [thread('t1', '2026-02-01T00:00:00Z')]),
        entry(project('b', 'New', 'github.com/x/new')),
      ]),
      source('host-1', [
        entry(project('c', 'New', 'github.com/x/new'), [thread('t2', '2026-03-01T00:00:00Z')]),
      ]),
    ])
    expect(merged.map((p) => p.name)).toEqual(['New', 'Old'])
    expect(merged[0].lastActivityAt).toBe('2026-03-01T00:00:00Z')
  })
})

describe('replaceUnifiedSources', () => {
  it('swaps refreshed sources in place and appends new ones', () => {
    const a = source('local', [])
    const b = source('host-1', [])
    const b2 = { ...source('host-1', []), label: 'renamed' }
    const c = source('host-2', [])
    expect(replaceUnifiedSources([a, b], [b2, c]).map((s) => s.label)).toEqual(['local', 'renamed', 'host-2'])
  })
})

describe('isUnifiedWatchedChannel', () => {
  it('forwards thread lifecycle events only', () => {
    expect(isUnifiedWatchedChannel('thread:status:abc')).toBe(true)
    expect(isUnifiedWatchedChannel('thread:complete:abc')).toBe(true)
    expect(isUnifiedWatchedChannel('thread:title:abc')).toBe(true)
    expect(isUnifiedWatchedChannel('thread:output:abc')).toBe(false)
    expect(isUnifiedWatchedChannel('terminal:data:x')).toBe(false)
  })
})

describe('readUnifiedSourceProjects', () => {
  const projects = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }) as Project)

  it('reads every Project without exceeding the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const call = async (channel: string, args: unknown[]): Promise<unknown> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      if (channel === 'projects:list') return projects
      if (channel === 'threads:list') return [{ id: `t-${String(args[0])}` }]
      if (channel === 'threads:archivedCount') return 2
      return channel.endsWith('Count') ? 0 : []
    }
    const result = await readUnifiedSourceProjects(call, 3)
    expect(peak).toBe(3)
    expect(inFlight).toBe(0)
    expect(result.projects.map((entry) => entry.project.id)).toEqual(projects.map((p) => p.id))
    expect(result.projects[4]).toMatchObject({ threads: [{ id: 't-p4' }], archivedCount: 2, snoozedCount: 0 })
  })

  it('rejects when the Project list cannot be read', async () => {
    await expect(readUnifiedSourceProjects(async () => { throw new Error('unreachable') })).rejects.toThrow('unreachable')
  })

  it('falls back to empty for any other read that fails, and keeps its slot count straight', async () => {
    const call = async (channel: string): Promise<unknown> => {
      if (channel === 'projects:list') return projects
      if (channel === 'threads:list') return [{ id: 't' }]
      throw new Error('refused')
    }
    const result = await readUnifiedSourceProjects(call, 2)
    expect(result.archivedProjects).toEqual([])
    expect(result.projects).toHaveLength(projects.length)
    expect(result.projects[0]).toMatchObject({ locations: [], pools: [], threads: [{ id: 't' }], archivedCount: 0 })
  })
})
