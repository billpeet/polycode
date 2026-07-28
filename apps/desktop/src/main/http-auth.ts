import { timingSafeEqual } from 'crypto'

export function isValidBearerToken(authHeader: string | undefined, token: string): boolean {
  const actual = Buffer.from(authHeader ?? '', 'utf8')
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
