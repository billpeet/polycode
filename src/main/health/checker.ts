import { spawn } from 'child_process'
import { SshConfig, WslConfig, Provider, CliHealthResult, CliUpdateResult } from '../../shared/types'
import { shellEscape, LOAD_NODE_MANAGERS, buildSshBaseArgs, augmentWindowsPath } from '../driver/runner'

interface SpawnResult {
  output: string
  exitCode: number | null
}

type CacheEntry<T> = {
  expiresAt: number
  value: T
}

const VERSION_CHECK_TTL_MS = 60_000
const LATEST_VERSION_TTL_MS = 15 * 60_000
const HEALTH_RESULT_TTL_MS = 60_000

const cliCache = new Map<string, CacheEntry<unknown>>()
const cliInFlight = new Map<string, Promise<unknown>>()

function readWithCache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const cached = cliCache.get(key) as CacheEntry<T> | undefined
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value)
  }

  const existing = cliInFlight.get(key) as Promise<T> | undefined
  if (existing) {
    return existing
  }

  const promise = fn()
    .then((value) => {
      cliCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      })
      return value
    })
    .finally(() => {
      cliInFlight.delete(key)
    })

  cliInFlight.set(key, promise)
  return promise
}

function getTransportCacheKey(connectionType: string, ssh?: SshConfig | null, wsl?: WslConfig | null): string {
  if (connectionType === 'ssh' && ssh) {
    return `ssh:${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
  }
  if (connectionType === 'wsl' && wsl) {
    return `wsl:${wsl.distro}`
  }
  return connectionType
}

function getVersionCacheKey(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): string {
  return `version:${provider}:${getTransportCacheKey(connectionType, ssh, wsl)}`
}

function getHealthCacheKey(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): string {
  return `health:${provider}:${getTransportCacheKey(connectionType, ssh, wsl)}`
}

function getLatestVersionCacheKey(packageName: string): string {
  return `latest:${packageName}`
}

export function invalidateCliHealthCache(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): void {
  const prefix = `${provider}:${getTransportCacheKey(connectionType, ssh, wsl)}`
  for (const key of cliCache.keys()) {
    if (key === `version:${prefix}` || key === `health:${prefix}`) {
      cliCache.delete(key)
    }
  }
  for (const key of cliInFlight.keys()) {
    if (key === `version:${prefix}` || key === `health:${prefix}`) {
      cliInFlight.delete(key)
    }
  }
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { shell?: boolean; timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let output = ''
    const timeout = opts.timeout ?? 15000

    const proc = spawn(cmd, args, {
      env: opts.env,
      shell: opts.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      resolve({ output, exitCode: null })
    }, timeout)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ output, exitCode: code })
    })

    proc.on('error', () => {
      clearTimeout(timer)
      resolve({ output, exitCode: null })
    })
  })
}

/** Extract a semver string from command output. */
function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)
  return match ? match[1] : null
}

/** Compare semver strings — returns true if current >= latest. */
function isUpToDate(current: string, latest: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
  const [ma1, mi1, pa1] = parse(current)
  const [ma2, mi2, pa2] = parse(latest)
  if (ma1 !== ma2) return ma1 > ma2
  if (mi1 !== mi2) return mi1 > mi2
  return pa1 >= pa2
}

/** Fetch latest published version of an npm package. */
async function fetchLatestVersion(packageName: string): Promise<string | null> {
  return readWithCache(getLatestVersionCacheKey(packageName), LATEST_VERSION_TTL_MS, async () => {
    try {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)
      if (!response.ok) return null
      const data = await response.json() as { version?: string }
      return data.version ?? null
    } catch {
      return null
    }
  })
}

const PROVIDER_INFO: Record<Provider, {
  cmd: string
  package: string
  /** Direct update command (e.g. `claude update`). Takes precedence over npm. */
  updateCmd?: string[]
  /** npm package to `npm install -g` when no updateCmd is set. */
  updatePkg?: string
}> = {
  // Claude Code uses its built-in `claude update` since it switched to a native installer.
  'claude-code': { cmd: 'claude',   package: '@anthropic-ai/claude-code', updateCmd: ['claude', 'update'] },
  'codex':       { cmd: 'codex',   package: '@openai/codex',             updatePkg: '@openai/codex@latest' },
  'opencode':    { cmd: 'opencode', package: 'opencode-ai',              updatePkg: 'opencode-ai@latest' },
  'pi':          { cmd: 'pi',      package: '@mariozechner/pi-coding-agent', updatePkg: '@mariozechner/pi-coding-agent@latest' },
}

function buildSshArgs(ssh: SshConfig): string[] {
  const args = buildSshBaseArgs(ssh)
  args.push('-o', 'BatchMode=yes')
  args.push(`${ssh.user}@${ssh.host}`)
  return args
}

async function runVersionCheck(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<SpawnResult> {
  return readWithCache(
    getVersionCacheKey(provider, connectionType, ssh, wsl),
    VERSION_CHECK_TTL_MS,
    async () => {
  const info = PROVIDER_INFO[provider]
  const versionCmd = `${info.cmd} --version 2>&1`

  if (connectionType === 'ssh' && ssh) {
    // LOAD_NODE_MANAGERS adds common tool dirs to PATH (.bashrc skips them in
    // non-interactive shells due to `case $- in *i*)` guard).
    const innerCmd = `${LOAD_NODE_MANAGERS}; ${versionCmd}`
    const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
    return runProcess('ssh', [...buildSshArgs(ssh), remoteCmd], { timeout: 20000 })
  }

  if (connectionType === 'wsl' && wsl) {
    return runProcess('wsl', ['-d', wsl.distro, '--', 'bash', '-ilc', versionCmd], { timeout: 20000 })
  }

  // Local
  return runProcess(info.cmd, ['--version'], {
    env: process.platform === 'win32' ? augmentWindowsPath() : process.env,
    shell: process.platform === 'win32',
    timeout: 10000,
  })
    }
  )
}

async function runUpdate(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<SpawnResult> {
  const info = PROVIDER_INFO[provider]

  // Build the shell command string for remote environments.
  // claude-code uses its own `claude update`; others use npm.
  function buildUpdateShellCmd(): string {
    if (info.updateCmd) {
      return `${info.updateCmd.join(' ')} 2>&1`
    }
    return `npm install -g ${info.updatePkg} 2>&1`
  }

  if (connectionType === 'ssh' && ssh) {
    const innerCmd = `${LOAD_NODE_MANAGERS}; ${buildUpdateShellCmd()}`
    const remoteCmd = `bash -lc ${shellEscape(innerCmd)}`
    return runProcess('ssh', [...buildSshArgs(ssh), remoteCmd], { timeout: 120000 })
  }

  if (connectionType === 'wsl' && wsl) {
    return runProcess('wsl', ['-d', wsl.distro, '--', 'bash', '-ilc', buildUpdateShellCmd()], { timeout: 120000 })
  }

  // Local
  if (info.updateCmd) {
    const [cmd, ...args] = info.updateCmd
    return runProcess(cmd, args, {
      env: process.platform === 'win32' ? augmentWindowsPath() : process.env,
      shell: process.platform === 'win32',
      timeout: 120000,
    })
  }
  return runProcess('npm', ['install', '-g', info.updatePkg!], {
    env: process.platform === 'win32' ? augmentWindowsPath() : process.env,
    shell: process.platform === 'win32',
    timeout: 120000,
  })
}

export async function checkCliHealth(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<CliHealthResult> {
  return readWithCache(
    getHealthCacheKey(provider, connectionType, ssh, wsl),
    HEALTH_RESULT_TTL_MS,
    async () => {
      const info = PROVIDER_INFO[provider]

      const [versionResult, latestVersion] = await Promise.all([
        runVersionCheck(provider, connectionType, ssh, wsl),
        fetchLatestVersion(info.package),
      ])

      const currentVersion = extractVersion(versionResult.output)
      const installed = currentVersion !== null
      const upToDate = installed && latestVersion ? isUpToDate(currentVersion, latestVersion) : null

      return { installed, currentVersion, latestVersion, upToDate }
    },
  )
}

export async function updateCli(
  provider: Provider,
  connectionType: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<CliUpdateResult> {
  const result = await runUpdate(provider, connectionType, ssh, wsl)
  return {
    success: result.exitCode === 0,
    output: result.output,
  }
}
