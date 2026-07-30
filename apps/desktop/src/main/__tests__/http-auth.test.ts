import { describe, expect, it } from 'vitest'
import { isValidBearerToken } from '../http-auth'

describe('isValidBearerToken', () => {
  it('accepts the expected bearer token', () => {
    expect(isValidBearerToken('Bearer secret-token', 'secret-token')).toBe(true)
  })

  it.each([
    undefined,
    '',
    'secret-token',
    'Basic secret-token',
    'Bearer wrong-token',
    'Bearer secret-token-extra',
  ])('rejects an invalid authorization header: %s', (authHeader) => {
    expect(isValidBearerToken(authHeader, 'secret-token')).toBe(false)
  })

  it('rejects authentication when the configured token is empty', () => {
    expect(isValidBearerToken('Bearer ', '')).toBe(false)
  })
})
