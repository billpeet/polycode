/**
 * Release-notes fetch for a pending update.
 *
 * The module talks to the GitHub compare API between the running version's tag
 * and the pending version's tag. The contract under test:
 *
 * - `null` when no update version is pending (never fetched).
 * - Commits mapped to `CommitLogEntry`, sorted oldest first regardless of the
 *   order the API answers with.
 * - Cached per pending version, so reopening the dialog does not refetch.
 * - A failed fetch degrades to an empty commit list with the release URL intact,
 *   because reviewing notes must never block installing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  state: { version: undefined as string | undefined },
  fetch: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getVersion: () => '0.14.194' } }))
vi.mock('../updater', () => ({ getUpdateState: () => ({ version: H.state.version }) }))

function commit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parents: [{ sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    commit: {
      message: 'feat: something\n\nLonger body that must not leak into the subject.',
      author: { name: 'Ada', email: 'ada@example.com', date: '2026-02-01T12:00:00Z' },
    },
    ...overrides,
  }
}

function okResponse(commits: Record<string, unknown>[]) {
  return { ok: true, status: 200, json: async () => ({ commits }) }
}

beforeEach(() => {
  vi.resetModules()
  H.fetch.mockReset()
  H.state.version = undefined
  vi.stubGlobal('fetch', H.fetch)
})

async function load(): Promise<typeof import('../release-notes')> {
  return import('../release-notes')
}

describe('getUpdateReleaseNotes', () => {
  it('answers null and never fetches when no update version is pending', async () => {
    const { getUpdateReleaseNotes } = await load()
    expect(await getUpdateReleaseNotes()).toBe(null)
    expect(H.fetch).not.toHaveBeenCalled()
  })

  it('compares the running tag to the pending tag and maps commits oldest first', async () => {
    H.state.version = '0.14.195'
    // Answered newest first, as the API may: the result must still read chronologically.
    H.fetch.mockResolvedValue(okResponse([
      commit({ sha: 'cccccccc'.padEnd(40, 'c'), commit: {
        message: 'fix: later change', author: { name: 'Bob', email: 'b@x.com', date: '2026-02-03T09:00:00Z' },
      } }),
      commit(),
    ]))

    const { getUpdateReleaseNotes } = await load()
    const notes = await getUpdateReleaseNotes()

    expect(H.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = H.fetch.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/billpeet/polycode/compare/v0.14.194...v0.14.195')
    expect((init as { headers: Record<string, string> }).headers.Accept).toBe('application/vnd.github+json')

    expect(notes).toEqual({
      version: '0.14.195',
      releaseUrl: 'https://github.com/billpeet/polycode/releases/tag/v0.14.195',
      commits: [
        {
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          shortSha: 'aaaaaaa',
          subject: 'feat: something',
          authorName: 'Ada',
          authorEmail: 'ada@example.com',
          authorDate: '2026-02-01T12:00:00Z',
          parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
        },
        {
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          shortSha: 'ccccccc',
          subject: 'fix: later change',
          authorName: 'Bob',
          authorEmail: 'b@x.com',
          authorDate: '2026-02-03T09:00:00Z',
          parents: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
        },
      ],
    })
  })

  it('caches per pending version — a repeat call does not refetch, a new version does', async () => {
    H.state.version = '0.14.195'
    H.fetch.mockResolvedValue(okResponse([commit()]))
    const { getUpdateReleaseNotes } = await load()

    const first = await getUpdateReleaseNotes()
    const second = await getUpdateReleaseNotes()
    expect(H.fetch).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)

    H.state.version = '0.14.196'
    H.fetch.mockResolvedValue(okResponse([]))
    const next = await getUpdateReleaseNotes()
    expect(H.fetch).toHaveBeenCalledTimes(2)
    expect(next?.version).toBe('0.14.196')
    expect(next?.commits).toEqual([])
  })

  it('degrades to an empty commit list (release URL intact) when the fetch fails', async () => {
    H.state.version = '0.14.195'
    H.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
    const { getUpdateReleaseNotes } = await load()

    const notes = await getUpdateReleaseNotes()
    expect(notes).toEqual({
      version: '0.14.195',
      releaseUrl: 'https://github.com/billpeet/polycode/releases/tag/v0.14.195',
      commits: [],
    })
  })

  it('degrades the same way when the fetch rejects', async () => {
    H.state.version = '0.14.195'
    H.fetch.mockRejectedValue(new Error('offline'))
    const { getUpdateReleaseNotes } = await load()

    const notes = await getUpdateReleaseNotes()
    expect(notes?.commits).toEqual([])
    expect(notes?.releaseUrl).toBe('https://github.com/billpeet/polycode/releases/tag/v0.14.195')
  })
})
