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

export function azureApiUrl(ctx: AzureRepoContext, resource: string, projectId?: string): URL {
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
  web.pathname = projectId
    ? `${prefix.slice(0, ctx.project ? prefix.lastIndexOf('/') : prefix.length)}/${encodeURIComponent(projectId)}/_apis/${resource}`
    : `${prefix}/_apis/git/repositories/${encodeURIComponent(ctx.repo)}/${resource}`
  return web
}

function connectionError(error: unknown): Error {
  const causes: unknown[] = [error]
  const codes = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
    'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  ])
  // Only expose known diagnostic codes, never raw messages, URLs or headers.
  for (let index = 0; index < causes.length && index < 16; index++) {
    const cause = causes[index]
    if (!(cause instanceof Error)) continue
    if (cause.message === 'unexpected redirect') {
      return new Error('Azure DevOps returned a redirect that Polycode blocked. Check the repository remote URL and PAT organization access.')
    }
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return new Error('Azure DevOps connection timed out. Check connectivity on the Polycode host and retry.')
    }
    const code = (cause as NodeJS.ErrnoException).code
    if (code && codes.has(code)) {
      return new Error(`Azure DevOps connection failed (${code}). Check network, proxy, and certificate settings on the Polycode host.`)
    }
    if (cause.cause) causes.push(cause.cause)
    if (cause instanceof AggregateError) causes.push(...cause.errors)
  }
  return new Error('Azure DevOps connection failed before an HTTP response was received. Check network, proxy, and certificate settings on the Polycode host.')
}

/** Azure REST traffic always runs on the Polycode host, including SSH/WSL repositories. */
export async function azureRequest<T>(ctx: AzureRepoContext, resource: string, query: Record<string, string> = {}, body?: unknown, projectId?: string): Promise<T> {
  const url = azureApiUrl(ctx, resource, projectId)
  const encrypted = getSetting(PAT_KEY)
  if (!encrypted) throw new Error('Azure DevOps authentication required. Add a PAT in Settings > Azure DevOps.')
  let pat: string
  try {
    pat = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error('Azure DevOps authentication unavailable. Save your PAT again in Settings > Azure DevOps.')
  }
  url.search = new URLSearchParams({ 'api-version': '7.1', ...query }).toString()
  const options: RequestInit = {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`,
      Accept: 'application/json', 'Content-Type': 'application/json',
      'X-TFS-FedAuthRedirect': 'Suppress',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
  }
  let currentUrl = url
  let response: Response
  for (let redirects = 0; ; redirects++) {
    response = await fetch(currentUrl, options).catch((error: unknown) => { throw connectionError(error) })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    let next: URL
    try {
      if (!location) throw new Error('missing location')
      next = new URL(location, currentUrl)
    } catch {
      throw new Error('Azure DevOps returned an invalid redirect.')
    }
    if (/\/(?:_signin|signin|oauth2)(?:\/|$)/i.test(next.pathname) || next.hostname === 'login.microsoftonline.com' || next.hostname === 'login.live.com') {
      throw new Error('Azure DevOps authentication required: the API redirected to sign-in. Check the PAT expiry, organization access, and Code permissions in Settings > Azure DevOps.')
    }
    // dev.azure.com hosts multiple organizations. Keep credentials in the
    // original organization, on HTTPS API routes, and never forward cross-origin.
    const organization = url.pathname.split('/')[1]
    if (next.origin !== url.origin || next.username || next.password ||
      (url.hostname === 'dev.azure.com' && next.pathname.split('/')[1] !== organization) ||
      !next.pathname.includes('/_apis/')) {
      throw new Error('Azure DevOps returned a redirect outside the repository API. Check the Git remote URL; use the current HTTPS clone URL from Azure DevOps.')
    }
    if (body !== undefined && response.status !== 307 && response.status !== 308) {
      throw new Error('Azure DevOps redirected a write request. Update the Git remote URL to the current HTTPS clone URL before retrying.')
    }
    if (redirects >= 3) throw new Error('Azure DevOps redirect limit exceeded. Check the Git remote URL.')
    currentUrl = next
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Azure DevOps authentication failed (HTTP ${response.status}). Check your PAT, organization access, and Code permissions in Settings > Azure DevOps.`)
  }
  if (!response.ok) throw new Error(`Azure DevOps request failed (HTTP ${response.status}).`)
  return response.json() as Promise<T>
}
