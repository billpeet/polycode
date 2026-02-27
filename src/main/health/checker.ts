import { spawn } from 'child_process'
import { SshConfig, WslConfig, Provider, CliHealthResult, CliUpdateResult } from '../../shared/types'
import { shellEscape, LOAD_NODE_MANAGERS, FIX_HOME, RESOLVE_CODEX_BIN_SOFT, buildSshBaseArgs } from '../driver/runner'

interface SpawnResult {
  output: string
  exitCode: number | null
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { shell?: boolean; timeout?: number } = {}
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let output = ''
    const timeout = opts.timeout ?? 15000

    const proc = spawn(cmd, args, {
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
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)
    if (!response.ok) return null
    const data = await response.json() as { version?: string }
    return data.version ?? null
  } catch {
    return null
  }
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
  const info = PROVIDER_INFO[provider]

  if (connectionType === 'ssh' && ssh) {
    const versionCmd = provider === 'codex'
      ? `${LOAD_NODE_MANAGERS}; ${RESOLVE_CODEX_BIN_SOFT}; [ -n "$CODEX_BIN" ] && "$CODEX_BIN" --version 2>&1 || echo "codex not found"`
      : `${info.cmd} --version 2>&1`
    const remoteCmd = `bash -lc ${shellEscape(versionCmd)}`
    return runProcess('ssh', [...buildSshArgs(ssh), remoteCmd], { timeout: 20000 })
  }

  if (connectionType === 'wsl' && wsl) {
    const versionCmd = provider === 'codex'
      ? `${FIX_HOME}; ${LOAD_NODE_MANAGERS}; ${RESOLVE_CODEX_BIN_SOFT}; [ -n "$CODEX_BIN" ] && "$CODEX_BIN" --version 2>&1 || echo "codex not found"`
      : `${info.cmd} --version 2>&1`
    return runProcess('wsl', ['-d', wsl.distro, '--', 'bash', '-lc', versionCmd], { timeout: 20000 })
  }

  // Local
  return runProcess(info.cmd, ['--version'], {
    shell: process.platform === 'win32',
    timeout: 10000,
  })
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
    const base = `npm install -g ${info.updatePkg} 2>&1`
    return provider === 'codex' ? `${LOAD_NODE_MANAGERS}; ${base}` : base
  }

  if (connectionType === 'ssh' && ssh) {
    const remoteCmd = `bash -lc ${shellEscape(buildUpdateShellCmd())}`
    return runProcess('ssh', [...buildSshArgs(ssh), remoteCmd], { timeout: 120000 })
  }

  if (connectionType === 'wsl' && wsl) {
    const innerCmd = provider === 'codex'
      ? `${FIX_HOME}; ${LOAD_NODE_MANAGERS}; npm install -g ${info.updatePkg} 2>&1`
      : buildUpdateShellCmd()
    return runProcess('wsl', ['-d', wsl.distro, '--', 'bash', '-lc', innerCmd], { timeout: 120000 })
  }

  // Local
  if (info.updateCmd) {
    const [cmd, ...args] = info.updateCmd
    return runProcess(cmd, args, {
      shell: process.platform === 'win32',
      timeout: 120000,
    })
  }
  return runProcess('npm', ['install', '-g', info.updatePkg!], {
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
  const info = PROVIDER_INFO[provider]

  const [versionResult, latestVersion] = await Promise.all([
    runVersionCheck(provider, connectionType, ssh, wsl),
    fetchLatestVersion(info.package),
  ])

  const currentVersion = extractVersion(versionResult.output)
  const installed = currentVersion !== null
  const upToDate = installed && latestVersion ? isUpToDate(currentVersion!, latestVersion) : null

  return { installed, currentVersion, latestVersion, upToDate }
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
