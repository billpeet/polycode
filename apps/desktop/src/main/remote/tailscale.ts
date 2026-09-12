import { existsSync } from 'fs'
import { createRunner, type Runner, type RunResult } from '../driver/runner'
import type { TailscaleServe, TailscaleServeScheme, TailscaleStatus } from '../../shared/types'

/**
 * Exposing this machine's remote-control server over its tailnet with `tailscale serve`.
 *
 * PolyCode keeps its loopback bind; Tailscale terminates TLS with a `*.ts.net` certificate,
 * applies the tailnet's ACLs, and forwards to `http://127.0.0.1:<port>` with the browser's
 * own `Host` — which is why the server's hostname allowlist exists. Everything here is a
 * thin driver over the CLI: read state with `status --json` / `serve status --json`, change
 * it with `serve --bg`. Nothing is cached; each call asks the daemon.
 */

const CLI_TIMEOUT_MS = 15_000
const HTTPS_PORT = 443
const HTTP_PORT = 80

/** Where installers put the CLI when it is not on PATH. */
const KNOWN_BINARIES: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale'],
}

export function resolveTailscaleBinary(platform = process.platform, exists = existsSync): string {
  for (const candidate of KNOWN_BINARIES[platform] ?? []) {
    if (exists(candidate)) return candidate
  }
  return 'tailscale'
}

export interface TailscaleCli {
  run(args: string[]): Promise<RunResult>
}

export function createTailscaleCli(runner: Runner = createRunner({}), binary = resolveTailscaleBinary()): TailscaleCli {
  return {
    run: (args) => runner.run({ binary, args, workDir: process.cwd(), timeoutMs: CLI_TIMEOUT_MS }),
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

interface StatusJson {
  BackendState?: string
  Self?: { DNSName?: string; TailscaleIPs?: string[] }
  CertDomains?: string[] | null
}

/** The subset of `ipn.ServeConfig` that `tailscale serve status --json` prints. */
interface ServeConfigJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
}

export interface ParsedStatus {
  running: boolean
  dnsName: string | null
  tailnetIps: string[]
  httpsAvailable: boolean
}

export function parseTailscaleStatus(stdout: string): ParsedStatus | null {
  let json: StatusJson
  try {
    json = JSON.parse(stdout) as StatusJson
  } catch {
    return null
  }
  const dnsName = json.Self?.DNSName?.replace(/\.$/, '') || null
  return {
    running: json.BackendState === 'Running',
    dnsName,
    tailnetIps: Array.isArray(json.Self?.TailscaleIPs) ? json.Self!.TailscaleIPs!.filter((ip) => typeof ip === 'string') : [],
    httpsAvailable: Array.isArray(json.CertDomains) && json.CertDomains.length > 0,
  }
}

/** Does this proxy target point at PolyCode's own port on loopback? */
function targetsLocalPort(proxy: string | undefined, port: number): boolean {
  if (!proxy) return false
  try {
    const url = new URL(proxy)
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === String(port)
  } catch {
    return false
  }
}

/** Find the serve entry forwarding to `localPort`, if any. `{}` means nothing is served. */
export function parseServeStatus(stdout: string, localPort: number): TailscaleServe | null {
  let json: ServeConfigJson
  try {
    json = JSON.parse(stdout || '{}') as ServeConfigJson
  } catch {
    return null
  }
  for (const [hostPort, web] of Object.entries(json.Web ?? {})) {
    const root = web.Handlers?.['/']
    if (!targetsLocalPort(root?.Proxy, localPort)) continue
    const separator = hostPort.lastIndexOf(':')
    const host = separator === -1 ? hostPort : hostPort.slice(0, separator)
    const port = separator === -1 ? HTTPS_PORT : Number(hostPort.slice(separator + 1))
    const scheme: TailscaleServeScheme = json.TCP?.[String(port)]?.HTTPS ? 'https' : 'http'
    const defaultPort = scheme === 'https' ? HTTPS_PORT : HTTP_PORT
    return {
      scheme,
      port,
      url: `${scheme}://${host}${port === defaultPort ? '' : `:${port}`}`,
    }
  }
  return null
}

// ── Status ───────────────────────────────────────────────────────────────────

const NOT_INSTALLED: TailscaleStatus = {
  installed: false,
  running: false,
  dnsName: null,
  tailnetIps: [],
  httpsAvailable: false,
  serve: null,
  error: null,
}

function looksUninstalled(result: RunResult): boolean {
  return result.exitCode === null && /ENOENT|not found|not recognized|No such file/i.test(result.stderr)
}

function failureMessage(result: RunResult, what: string): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split('\n').at(-1) ?? ''
  return text || (result.timedOut ? `${what} timed out` : `${what} exited with code ${result.exitCode}`)
}

export async function getTailscaleStatus(localPort: number, cli: TailscaleCli = createTailscaleCli()): Promise<TailscaleStatus> {
  const status = await cli.run(['status', '--json'])
  if (looksUninstalled(status)) return NOT_INSTALLED

  const parsed = parseTailscaleStatus(status.stdout)
  if (!parsed) {
    // The daemon is stopped or the CLI could not reach it: no JSON, a message instead.
    return { ...NOT_INSTALLED, installed: true, error: failureMessage(status, 'tailscale status') }
  }

  const base: TailscaleStatus = { ...NOT_INSTALLED, installed: true, ...parsed, error: null }
  if (!parsed.running) return base

  const serve = await cli.run(['serve', 'status', '--json'])
  if (serve.exitCode !== 0) {
    return { ...base, error: failureMessage(serve, 'tailscale serve status') }
  }
  return { ...base, serve: parseServeStatus(serve.stdout, localPort) }
}

// ── Actions ──────────────────────────────────────────────────────────────────

function serveArgs(scheme: TailscaleServeScheme, localPort: number): string[] {
  const listen = scheme === 'https' ? `--https=${HTTPS_PORT}` : `--http=${HTTP_PORT}`
  return ['serve', '--bg', listen, `http://127.0.0.1:${localPort}`]
}

function serveOffArgs(serve: TailscaleServe): string[] {
  return ['serve', `--${serve.scheme}=${serve.port}`, 'off']
}

/**
 * Point the tailnet at PolyCode. Idempotent: re-running with the same scheme rewrites the
 * same entry, and switching scheme removes the other first so only one exists.
 */
export async function enableTailscaleServe(
  scheme: TailscaleServeScheme,
  localPort: number,
  cli: TailscaleCli = createTailscaleCli(),
): Promise<TailscaleStatus> {
  const before = await getTailscaleStatus(localPort, cli)
  if (!before.installed || !before.running) {
    return { ...before, error: before.error ?? (before.installed ? 'Tailscale is not running' : 'Tailscale is not installed') }
  }
  if (scheme === 'https' && !before.httpsAvailable) {
    return { ...before, error: 'HTTPS certificates are not enabled for this tailnet' }
  }
  if (before.serve && before.serve.scheme !== scheme) {
    const off = await cli.run(serveOffArgs(before.serve))
    if (off.exitCode !== 0) return { ...before, error: failureMessage(off, 'tailscale serve off') }
  }

  const result = await cli.run(serveArgs(scheme, localPort))
  if (result.exitCode !== 0) {
    return { ...before, error: failureMessage(result, 'tailscale serve') }
  }
  return getTailscaleStatus(localPort, cli)
}

export async function disableTailscaleServe(
  localPort: number,
  cli: TailscaleCli = createTailscaleCli(),
): Promise<TailscaleStatus> {
  const before = await getTailscaleStatus(localPort, cli)
  if (!before.serve) return before

  const result = await cli.run(serveOffArgs(before.serve))
  if (result.exitCode !== 0) {
    return { ...before, error: failureMessage(result, 'tailscale serve off') }
  }
  return getTailscaleStatus(localPort, cli)
}
