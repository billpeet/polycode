import { timingSafeEqual } from 'crypto'

/** Constant-time comparison of a presented secret against the configured one. */
export function isValidToken(presented: string | undefined, expected: string): boolean {
  if (!expected) return false

  const actual = Buffer.from(presented ?? '', 'utf8')
  const wanted = Buffer.from(expected, 'utf8')

  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

export function isValidBearerToken(authHeader: string | undefined, token: string): boolean {
  if (!token) return false
  return isValidToken(authHeader, `Bearer ${token}`)
}
