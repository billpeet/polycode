import { normalizeBaseUrl } from './client'

/**
 * Pairing payload shared with the desktop Remote Control panel QR code:
 *   polycode://pair?v=1&url=<encoded baseUrl>&token=<hex>&name=<encoded label>
 */
export interface PairingPayload {
  baseUrl: string
  token: string
  name?: string
}

export function parsePairingPayload(data: string): PairingPayload | null {
  try {
    const url = new URL(data)
    if (url.protocol !== 'polycode:') return null
    // Depending on the parser, `polycode://pair?...` puts "pair" in host or pathname.
    const target = url.hostname || url.pathname.replace(/^\/+/, '')
    if (target !== 'pair') return null
    const baseUrl = url.searchParams.get('url')
    const token = url.searchParams.get('token')
    if (!baseUrl || !token) return null
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      token: token.trim(),
      name: url.searchParams.get('name')?.trim() || undefined,
    }
  } catch {
    return null
  }
}

export function buildPairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams()
  params.set('v', '1')
  params.set('url', payload.baseUrl)
  params.set('token', payload.token)
  if (payload.name) params.set('name', payload.name)
  return `polycode://pair?${params.toString()}`
}
