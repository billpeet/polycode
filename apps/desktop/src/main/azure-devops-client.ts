import { safeStorage } from 'electron'
import { forgeReadCache } from './forge-cache'
import { getSetting, setSetting } from './db/queries'
import { buildAzureRepoUrl, type AzureRepoContext } from './forge-parsers'

const PAT_KEY = 'azure-devops.pat.encrypted'

export function hasAzurePat(): boolean {
  return Boolean(getSetting(PAT_KEY))
}

export function saveAzurePat(token: string): void {
  const pat = token.trim()
  if (!pat) { setSetting(PAT_KEY, ''); forgeReadCache.clear(); return }
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Secure credential storage is unavailable on this computer.')
  }
  setSetting(PAT_KEY, safeStorage.encryptString(pat).toString('base64'))
  forgeReadCache.clear()
}

export function azureApiUrl(ctx: AzureRepoContext, resource: string): URL {
  const repoUrl = buildAzureRepoUrl(ctx.remoteUrl)
  if (!repoUrl.startsWith('https://')) {
    throw new Error('Cannot determine Azure DevOps organization. Use a dev.azure.com HTTPS or v3 SSH remote.')
  }
  const web = new URL(repoUrl)
  if (web.protocol !== 'https:' || !(web.hostname === 'dev.azure.com' || /^[^.]+\.visualstudio\.com$/i.test(web.hostname))) {
    throw new Error('Cannot determine Azure DevOps organization. Use a dev.azure.com HTTPS or v3 SSH remote.')
  }
  web.username = ''
  web.password = ''
  web.search = ''
  web.hash = ''
  const prefix = web.pathname.split('/_git/')[0]
  web.pathname = `${prefix}/_apis/git/repositories/${encodeURIComponent(ctx.repo)}/${resource}`
  return web
}

/** Azure REST traffic always runs on the Polycode host, including SSH/WSL repositories. */
export async function azureRequest<T>(ctx: AzureRepoContext, resource: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const url = azureApiUrl(ctx, resource)
  const encrypted = getSetting(PAT_KEY)
  if (!encrypted) throw new Error('Azure DevOps authentication required. Add a PAT in Settings > Azure DevOps.')
  let pat: string
  try {
    pat = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error('Azure DevOps authentication unavailable. Save your PAT again in Settings > Azure DevOps.')
  }
  url.search = new URLSearchParams({ ...query, 'api-version': '7.1' }).toString()
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Azure DevOps authentication failed (HTTP ${response.status}). Check your PAT, organization access, and Code permissions in Settings > Azure DevOps.`)
  }
  if (!response.ok) throw new Error(`Azure DevOps request failed (HTTP ${response.status}).`)
  return response.json() as Promise<T>
}
