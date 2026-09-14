import { forgeReadCache, repoContextCache } from '../forge-cache'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  encryption: vi.fn(() => true),
  fetch: vi.fn(),
}))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: mocks.encryption,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace('encrypted:', ''),
  getSelectedStorageBackend: () => 'keychain',
} }))
vi.mock('../db/queries', () => ({
  getSetting: (key: string) => mocks.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => mocks.settings.set(key, value),
}))
import { azureApiUrl, azureRequest, hasAzurePat, saveAzurePat } from '../azure-devops-client'
import { parseAzureRemote } from '../forge-parsers'

const ctx = parseAzureRemote('git@ssh.dev.azure.com:v3/org/My%20Project/My%20Repo')!

beforeEach(() => {
  mocks.settings.clear()
  mocks.encryption.mockReturnValue(true)
  mocks.fetch.mockReset()
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => vi.unstubAllGlobals())

describe('Azure DevOps REST client', () => {
  it.each([
    ['git@ssh.dev.azure.com:v3/org/My%20Project/repo', 'https://dev.azure.com/org/project-id/_apis/policy/evaluations'],
    ['https://org.visualstudio.com/DefaultCollection/project/_git/repo', 'https://org.visualstudio.com/DefaultCollection/project-id/_apis/policy/evaluations'],
    ['https://user@dev.azure.com/org/_git/repo', 'https://dev.azure.com/org/project-id/_apis/policy/evaluations'],
  ])('builds project-scoped policy URLs for %s', (remote, expected) => {
    expect(azureApiUrl(parseAzureRemote(remote)!, 'policy/evaluations', 'project-id').toString()).toBe(expected)
  })

  it('uses the policy API preview version', async () => {
    saveAzurePat('secret')
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ value: [] }) })
    await azureRequest(ctx, 'policy/evaluations', { 'api-version': '7.1-preview.1' }, undefined, 'project-id')
    expect(mocks.fetch.mock.calls[0][0].searchParams.get('api-version')).toBe('7.1-preview.1')
  })
  it.each([
    ['git@ssh.dev.azure.com:v3/org/My%20Project/My%20Repo', 'https://dev.azure.com/org/My%20Project/_apis/git/repositories/My%20Repo/pullrequests'],
    ['https://user@dev.azure.com/org/_git/repo', 'https://dev.azure.com/org/_apis/git/repositories/repo/pullrequests'],
    ['https://org.visualstudio.com/DefaultCollection/project/_git/repo', 'https://org.visualstudio.com/DefaultCollection/project/_apis/git/repositories/repo/pullrequests'],
  ])('builds API URLs for %s', (remote, expected) => {
    expect(azureApiUrl(parseAzureRemote(remote)!, 'pullrequests').toString()).toBe(expected)
  })

  it('stores an encrypted PAT and removes it without exposing it through status', () => {
    saveAzurePat(' secret ')
    expect(hasAzurePat()).toBe(true)
    expect([...mocks.settings.values()]).not.toContain('secret')
    saveAzurePat('')
    expect(hasAzurePat()).toBe(false)
  })

  it('refuses plaintext storage when encryption is unavailable', () => {
    mocks.encryption.mockReturnValue(false)
    expect(() => saveAzurePat('secret')).toThrow('Secure credential storage')
    expect(hasAzurePat()).toBe(false)
  })

  it('requires a PAT before making a request', async () => {
    await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow('Settings > Azure DevOps')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('sends authenticated JSON directly with encoded queries and blocks redirects', async () => {
    saveAzurePat('secret')
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ pullRequestId: 42 }) })
    const body = { title: 'A title', sourceRefName: 'refs/heads/feature' }
    await expect(azureRequest(ctx, 'pullrequests', { 'searchCriteria.status': 'active' }, body)).resolves.toEqual({ pullRequestId: 42 })
    const [url, options] = mocks.fetch.mock.calls[0]
    expect(url.searchParams.get('api-version')).toBe('7.1')
    expect(url.searchParams.get('searchCriteria.status')).toBe('active')
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', body: JSON.stringify(body), headers: { Authorization: `Basic ${Buffer.from(':secret').toString('base64')}` } })
  })

  it.each([401, 403, 500])('reports HTTP %s without disclosing response bodies', async (status) => {
    saveAzurePat('secret')
    mocks.fetch.mockResolvedValue({ ok: false, status, text: async () => 'secret' })
    await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow(`HTTP ${status}`)
  })
})

it.each(['replacement', ''])('retires cached and in-flight reads on PAT change (%s), preserving remote discovery', async (pat) => {
  forgeReadCache.clear()
  repoContextCache.clear()
  const context = vi.fn(async () => ctx)
  await repoContextCache.read('repo', Infinity, context)
  await forgeReadCache.read('cached', 30_000, async () => 'old')
  let finish!: (value: string) => void
  const pending = forgeReadCache.read('pending', 30_000, () => new Promise<string>(resolve => { finish = resolve }))
  await Promise.resolve()
  saveAzurePat(pat)
  expect(await forgeReadCache.read('cached', 30_000, async () => 'new')).toBe('new')
  expect(await forgeReadCache.read('pending', 30_000, async () => 'new')).toBe('new')
  finish('old')
  await pending
  expect(await forgeReadCache.read('pending', 30_000, async () => 'unexpected')).toBe('new')
  await repoContextCache.read('repo', Infinity, context)
  expect(context).toHaveBeenCalledOnce()
})

it('reports the underlying connection failure without exposing raw error details', async () => {
  saveAzurePat('secret')
  mocks.fetch.mockRejectedValue(new TypeError('fetch failed', { cause: Object.assign(new Error('secret'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }))
  await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  await expect(azureRequest(ctx, 'pullrequests')).rejects.not.toThrow('secret')
})

it('distinguishes a blocked redirect from a connection failure', async () => {
  saveAzurePat('secret')
  mocks.fetch.mockRejectedValue(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))
  await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow('redirect')
})

it('requests API authentication errors instead of browser sign-in redirects', async () => {
  saveAzurePat('secret')
  mocks.fetch.mockImplementation(async (_url, options) => {
    if (options.headers['X-TFS-FedAuthRedirect'] !== 'Suppress') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    return { ok: false, status: 401 }
  })
  await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow('authentication failed (HTTP 401)')
})

it('follows a same-organization API redirect', async () => {
  saveAzurePat('secret')
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/org/My%20Project/_apis/git/repositories/repo-id/pullrequests?api-version=7.1' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })))
  await expect(azureRequest(ctx, 'pullrequests')).resolves.toEqual({ value: [] })
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

it.each([
  'https://login.microsoftonline.com/tenant/oauth2/authorize?secret=value',
  'https://other.example/_apis/git/repositories/repo/pullrequests',
  'https://dev.azure.com/other-org/_apis/git/repositories/repo/pullrequests',
  'http://dev.azure.com/org/_apis/git/repositories/repo/pullrequests',
])('does not forward credentials to an unsafe redirect', async (location) => {
  saveAzurePat('secret')
  mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: location } }))
  await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow(/authentication|redirect/)
  expect(mocks.fetch).toHaveBeenCalledOnce()
})

it('bounds redirect loops', async () => {
  saveAzurePat('secret')
  mocks.fetch.mockImplementation(async (url) => new Response(null, { status: 307, headers: { Location: String(url) } }))
  await expect(azureRequest(ctx, 'pullrequests')).rejects.toThrow('redirect limit')
  expect(mocks.fetch).toHaveBeenCalledTimes(4)
})

it.each([307, 308])('preserves a PR creation body on HTTP %s', async (status) => {
  saveAzurePat('secret')
  mocks.fetch.mockResolvedValueOnce(new Response(null, { status, headers: { Location: '/org/My%20Project/_apis/git/repositories/repo-id/pullrequests?api-version=7.1' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ pullRequestId: 42 })))
  await expect(azureRequest(ctx, 'pullrequests', {}, { title: 'Title' })).resolves.toEqual({ pullRequestId: 42 })
  expect(mocks.fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ title: 'Title' }) })
})

it('does not replay a write on a redirect that changes method semantics', async () => {
  saveAzurePat('secret')
  mocks.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: '/org/_apis/git/repositories/repo-id/pullrequests' } }))
  await expect(azureRequest(ctx, 'pullrequests', {}, { title: 'Title' })).rejects.toThrow('redirected a write request')
  expect(mocks.fetch).toHaveBeenCalledOnce()
})
