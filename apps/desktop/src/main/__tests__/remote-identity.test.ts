import { describe, expect, it } from 'vitest'
import { normalizeTailscaleLogins, tailscaleIdentityLogin } from '../remote/identity'

const config = { webEnabled: true, tailscaleLogins: ['owner@example.com'] }
const loopback = '127.0.0.1'

describe('tailscaleIdentityLogin', () => {
  it('admits an allow-listed login arriving through the local proxy', () => {
    expect(tailscaleIdentityLogin(loopback, { 'tailscale-user-login': 'owner@example.com' }, config)).toBe('owner@example.com')
    expect(tailscaleIdentityLogin('::1', { 'tailscale-user-login': 'Owner@Example.com ' }, config)).toBe('owner@example.com')
    expect(tailscaleIdentityLogin('::ffff:127.0.0.1', { 'tailscale-user-login': ['owner@example.com'] }, config)).toBe('owner@example.com')
  })

  it('ignores the header from any peer that is not loopback', () => {
    expect(tailscaleIdentityLogin('100.64.0.9', { 'tailscale-user-login': 'owner@example.com' }, config)).toBeNull()
    expect(tailscaleIdentityLogin('192.168.1.20', { 'tailscale-user-login': 'owner@example.com' }, config)).toBeNull()
    expect(tailscaleIdentityLogin(undefined, { 'tailscale-user-login': 'owner@example.com' }, config)).toBeNull()
  })

  it('never signs in a Funnel request, whoever it claims to be', () => {
    expect(tailscaleIdentityLogin(loopback, {
      'tailscale-user-login': 'owner@example.com',
      'tailscale-funnel-request': '?1',
    }, config)).toBeNull()
  })

  it('admits only the logins the user chose', () => {
    expect(tailscaleIdentityLogin(loopback, { 'tailscale-user-login': 'guest@example.com' }, config)).toBeNull()
    expect(tailscaleIdentityLogin(loopback, {}, config)).toBeNull()
    expect(tailscaleIdentityLogin(loopback, { 'tailscale-user-login': '' }, config)).toBeNull()
  })

  it('is off entirely while web access is off or no login is listed', () => {
    const headers = { 'tailscale-user-login': 'owner@example.com' }
    expect(tailscaleIdentityLogin(loopback, headers, { webEnabled: false, tailscaleLogins: ['owner@example.com'] })).toBeNull()
    expect(tailscaleIdentityLogin(loopback, headers, { webEnabled: true, tailscaleLogins: [] })).toBeNull()
  })
})

describe('normalizeTailscaleLogins', () => {
  it('lower-cases, trims, deduplicates and drops anything that is not one login', () => {
    expect(normalizeTailscaleLogins([' Owner@Example.com', 'owner@example.com', 'a b', '', 42, 'github:someone'])).toEqual([
      'owner@example.com',
      'github:someone',
    ])
    expect(normalizeTailscaleLogins('owner@example.com')).toEqual([])
    expect(normalizeTailscaleLogins(undefined)).toEqual([])
  })
})
