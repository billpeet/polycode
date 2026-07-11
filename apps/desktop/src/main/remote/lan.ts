import { hostname, networkInterfaces } from 'os'
import { RemotePairingInfo } from '../../shared/types'

/**
 * Non-internal IPv4 addresses of this machine, private-range first, for
 * building the mobile pairing QR code. The desktop server must be bound to
 * 0.0.0.0 (or one of these) for a phone on the LAN to reach it.
 */
export function getLanAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && (entry.family as unknown) !== 4) continue
      addresses.push(entry.address)
    }
  }
  const isPrivate = (address: string): boolean =>
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  return [...new Set(addresses)].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))
}

export function getPairingInfo(): RemotePairingInfo {
  return { addresses: getLanAddresses(), hostname: hostname() }
}
