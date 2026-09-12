import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../driver/runner'
import {
  disableTailscaleServe,
  enableTailscaleServe,
  getTailscaleStatus,
  parseServeStatus,
  parseTailscaleStatus,
  resolveTailscaleBinary,
  type TailscaleCli,
} from '../remote/tailscale'

/** Captured from `tailscale status --json` on a logged-in Windows machine (1.102). */
const STATUS_RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'futura-gpc.tail5d34f.ts.net.', TailscaleIPs: ['100.106.202.97', 'fd7a:115c:a1e0::5101:ca63'], HostName: 'FUTURA-GPC', UserID: 7 },
  User: { '7': { ID: 7, LoginName: 'Owner@Example.com', DisplayName: 'Owner' } },
  CurrentTailnet: { MagicDNSSuffix: 'tail5d34f.ts.net', MagicDNSEnabled: true },
  CertDomains: null,
})

const STATUS_WITH_CERTS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'pc.tailnet.ts.net.', TailscaleIPs: ['100.1.2.3'], UserID: 7 },
  User: { '7': { ID: 7, LoginName: 'owner@example.com' } },
  CertDomains: ['pc.tailnet.ts.net'],
})

const SERVE_HTTPS = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: { 'pc.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3285' } } } },
})

const SERVE_HTTP = JSON.stringify({
  TCP: { '80': { HTTP: true } },
  Web: { 'pc.tailnet.ts.net:80': { Handlers: { '/': { Proxy: 'http://localhost:3285' } } } },
})

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', exitCode: 0, timedOut: false })
const failed = (stderr: string, exitCode = 1): RunResult => ({ stdout: '', stderr, exitCode, timedOut: false })
const missing = (): RunResult => ({ stdout: '', stderr: 'spawn tailscale ENOENT', exitCode: null, timedOut: false })

/** A CLI scripted per argv string; unscripted calls fail loudly. */
function cli(script: Record<string, RunResult | RunResult[]>): TailscaleCli & { calls: string[] } {
  const remaining = new Map(Object.entries(script).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]))
  const calls: string[] = []
  return {
    calls,
    run: vi.fn(async (args: string[]) => {
      const key = args.join(' ')
      calls.push(key)
      const queue = remaining.get(key)
      if (!queue || queue.length === 0) throw new Error(`unscripted tailscale call: ${key}`)
      return queue.length > 1 ? queue.shift()! : queue[0]
    }),
  }
}

describe('parseTailscaleStatus', () => {
  it('strips the trailing dot from the MagicDNS name and reads cert availability', () => {
    expect(parseTailscaleStatus(STATUS_RUNNING)).toEqual({
      running: true,
      dnsName: 'futura-gpc.tail5d34f.ts.net',
      login: 'owner@example.com',
      tailnetIps: ['100.106.202.97', 'fd7a:115c:a1e0::5101:ca63'],
      httpsAvailable: false,
    })
    expect(parseTailscaleStatus(STATUS_WITH_CERTS)?.httpsAvailable).toBe(true)
  })

  it('reports a stopped or logged-out daemon as not running', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))).toEqual({
      running: false, dnsName: null, login: null, tailnetIps: [], httpsAvailable: false,
    })
    expect(parseTailscaleStatus('failed to connect to local tailscaled')).toBeNull()
  })
})

describe('parseServeStatus', () => {
  it('finds the entry that forwards to our port and derives the browser URL', () => {
    expect(parseServeStatus(SERVE_HTTPS, 3285)).toEqual({ scheme: 'https', port: 443, url: 'https://pc.tailnet.ts.net', funnel: false })
    expect(parseServeStatus(SERVE_HTTP, 3285)).toEqual({ scheme: 'http', port: 80, url: 'http://pc.tailnet.ts.net', funnel: false })
  })

  it('ignores entries that serve something else', () => {
    expect(parseServeStatus(SERVE_HTTPS, 9999)).toBeNull()
    expect(parseServeStatus('{}', 3285)).toBeNull()
    expect(parseServeStatus('', 3285)).toBeNull()
    const other = JSON.stringify({ Web: { 'pc.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://192.168.1.5:3285' } } } } })
    expect(parseServeStatus(other, 3285)).toBeNull()
  })

  it('keeps a non-default port in the URL', () => {
    const custom = JSON.stringify({
      TCP: { '8443': { HTTPS: true } },
      Web: { 'pc.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3285' } } } },
    })
    expect(parseServeStatus(custom, 3285)?.url).toBe('https://pc.tailnet.ts.net:8443')
  })
})

describe('getTailscaleStatus', () => {
  it('describes a running node with nothing served', async () => {
    const status = await getTailscaleStatus(3285, cli({ 'status --json': ok(STATUS_RUNNING), 'serve status --json': ok('{}') }))
    expect(status).toEqual({
      installed: true,
      running: true,
      dnsName: 'futura-gpc.tail5d34f.ts.net',
      login: 'owner@example.com',
      tailnetIps: ['100.106.202.97', 'fd7a:115c:a1e0::5101:ca63'],
      httpsAvailable: false,
      serve: null,
      error: null,
    })
  })

  it('reports an absent CLI as not installed without probing further', async () => {
    const c = cli({ 'status --json': missing() })
    expect(await getTailscaleStatus(3285, c)).toMatchObject({ installed: false, running: false, error: null })
    expect(c.calls).toEqual(['status --json'])
  })

  it('surfaces a stopped daemon as installed-but-not-running with its message', async () => {
    const c = cli({ 'status --json': failed('failed to connect to local tailscaled; is it running?') })
    expect(await getTailscaleStatus(3285, c)).toMatchObject({
      installed: true, running: false, error: 'failed to connect to local tailscaled; is it running?',
    })
  })

  it('does not consult serve while logged out', async () => {
    const c = cli({ 'status --json': ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} })) })
    expect(await getTailscaleStatus(3285, c)).toMatchObject({ installed: true, running: false, serve: null })
    expect(c.calls).toEqual(['status --json'])
  })
})

describe('enableTailscaleServe', () => {
  it('serves HTTPS in the background and re-reads the resulting state', async () => {
    const c = cli({
      'status --json': ok(STATUS_WITH_CERTS),
      'serve status --json': [ok('{}'), ok(SERVE_HTTPS)],
      'serve --bg --https=443 http://127.0.0.1:3285': ok(''),
    })
    const status = await enableTailscaleServe('https', 3285, c)
    expect(status.serve).toEqual({ scheme: 'https', port: 443, url: 'https://pc.tailnet.ts.net', funnel: false })
    expect(status.error).toBeNull()
    expect(c.calls).toContain('serve --bg --https=443 http://127.0.0.1:3285')
  })

  it('refuses HTTPS while the tailnet has no certificates, before touching serve', async () => {
    const c = cli({ 'status --json': ok(STATUS_RUNNING), 'serve status --json': ok('{}') })
    const status = await enableTailscaleServe('https', 3285, c)
    expect(status.error).toMatch(/HTTPS certificates are not enabled/)
    expect(c.calls.some((call) => call.startsWith('serve --bg'))).toBe(false)
  })

  it('falls back to plain HTTP on request', async () => {
    const c = cli({
      'status --json': ok(STATUS_RUNNING),
      'serve status --json': [ok('{}'), ok(SERVE_HTTP)],
      'serve --bg --http=80 http://127.0.0.1:3285': ok(''),
    })
    const status = await enableTailscaleServe('http', 3285, c)
    expect(status.serve?.url).toBe('http://pc.tailnet.ts.net')
  })

  it('removes the other scheme when switching so only one entry exists', async () => {
    const c = cli({
      'status --json': ok(STATUS_WITH_CERTS),
      'serve status --json': [ok(SERVE_HTTP), ok(SERVE_HTTPS)],
      'serve --http=80 off': ok(''),
      'serve --bg --https=443 http://127.0.0.1:3285': ok(''),
    })
    const status = await enableTailscaleServe('https', 3285, c)
    expect(status.serve?.scheme).toBe('https')
    expect(c.calls.indexOf('serve --http=80 off')).toBeLessThan(c.calls.indexOf('serve --bg --https=443 http://127.0.0.1:3285'))
  })

  it('reports the CLI error verbatim when serve fails', async () => {
    const c = cli({
      'status --json': ok(STATUS_WITH_CERTS),
      'serve status --json': ok('{}'),
      'serve --bg --https=443 http://127.0.0.1:3285': failed('error: serve is not permitted by your tailnet policy'),
    })
    expect((await enableTailscaleServe('https', 3285, c)).error).toBe('error: serve is not permitted by your tailnet policy')
  })

  it('explains when Tailscale is missing or stopped', async () => {
    expect((await enableTailscaleServe('https', 3285, cli({ 'status --json': missing() }))).error).toBe('Tailscale is not installed')
    const stopped = cli({ 'status --json': ok(JSON.stringify({ BackendState: 'Stopped', Self: {} })) })
    expect((await enableTailscaleServe('https', 3285, stopped)).error).toBe('Tailscale is not running')
  })
})

describe('Tailscale Funnel', () => {
  const SERVE_FUNNELED = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { 'pc.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3285' } } } },
    AllowFunnel: { 'pc.tailnet.ts.net:443': true },
  })

  it('reports when the served port is published to the internet', () => {
    expect(parseServeStatus(SERVE_FUNNELED, 3285)?.funnel).toBe(true)
    expect(parseServeStatus(SERVE_HTTPS, 3285)?.funnel).toBe(false)
  })

  it('refuses to expose while Funnel is on, and says how to turn it off', async () => {
    const c = cli({ 'status --json': ok(STATUS_WITH_CERTS), 'serve status --json': ok(SERVE_FUNNELED) })
    const status = await enableTailscaleServe('https', 3285, c)
    expect(status.error).toMatch(/Funnel is enabled/)
    expect(status.error).toContain('tailscale funnel --https=443 off')
    expect(c.calls.some((call) => call.startsWith('serve --bg'))).toBe(false)
  })
})

describe('disableTailscaleServe', () => {
  it('turns off exactly the entry that pointed at us', async () => {
    const c = cli({
      'status --json': ok(STATUS_WITH_CERTS),
      'serve status --json': [ok(SERVE_HTTPS), ok('{}')],
      'serve --https=443 off': ok(''),
    })
    const status = await disableTailscaleServe(3285, c)
    expect(status.serve).toBeNull()
    expect(c.calls).toContain('serve --https=443 off')
  })

  it('is a no-op when nothing points at us', async () => {
    const c = cli({ 'status --json': ok(STATUS_WITH_CERTS), 'serve status --json': ok('{}') })
    await disableTailscaleServe(3285, c)
    expect(c.calls.filter((call) => call.endsWith(' off'))).toEqual([])
  })
})

describe('resolveTailscaleBinary', () => {
  it('prefers the installer location when PATH may not have it, else the bare name', () => {
    expect(resolveTailscaleBinary('win32', (p) => p.startsWith('C:\\Program Files\\Tailscale'))).toBe('C:\\Program Files\\Tailscale\\tailscale.exe')
    expect(resolveTailscaleBinary('win32', () => false)).toBe('tailscale')
    expect(resolveTailscaleBinary('linux', () => true)).toBe('tailscale')
  })
})
