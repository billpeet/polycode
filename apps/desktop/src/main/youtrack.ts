import type { YouTrackIssue } from '../shared/types'

export async function testYouTrackConnection(url: string, token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const apiUrl = `${url.replace(/\/$/, '')}/api/users/me?fields=login,name`
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function searchYouTrack(url: string, token: string, query: string): Promise<YouTrackIssue[]> {
  try {
    const params = new URLSearchParams({ query, fields: 'id,idReadable,summary', $top: '20' })
    const apiUrl = `${url.replace(/\/$/, '')}/api/issues?${params}`
    const response = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return []
    return response.json() as Promise<YouTrackIssue[]>
  } catch {
    return []
  }
}
