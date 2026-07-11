/**
 * Integration tests for LocalRunner, WslRunner, and SshRunner.
 * Tests use simple OS commands (echo, cat, sh -c) rather than actual CLI binaries.
 *
 * WslRunner tests: skip if not Windows or WSL unavailable.
 * SshRunner tests: skip if SSH to localhost is unavailable.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { spawnSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import { LocalRunner } from '../runner/local'
import { WslRunner } from '../runner/wsl'
import { SshRunner } from '../runner/ssh'
import type { SpawnCommand } from '../runner/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all stdout + stderr from a ChildProcess and wait for close. */
function collect(proc: ChildProcess): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    proc.on('close', (code) => resolve({ stdout, stderr, code }))
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: -1 }))
  })
}

const isWindows = process.platform === 'win32'
const WORK_DIR = process.cwd()

// ── LocalRunner ───────────────────────────────────────────────────────────────

describe('LocalRunner — basic spawn', () => {
  it('spawns echo and captures stdout', async () => {
    const runner = new LocalRunner()
    const cmd: SpawnCommand = {
      binary: isWindows ? 'cmd' : 'echo',
      args: isWindows ? ['/c', 'echo', 'hello'] : ['hello'],
      workDir: WORK_DIR,
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('hello')
  })

  it('spawns with stdinContent — cat reads from stdin', async () => {
    // Skip on Windows where `cat` may not exist
    if (isWindows) return
    const runner = new LocalRunner()
    const cmd: SpawnCommand = {
      binary: 'cat',
      args: [],
      workDir: WORK_DIR,
      stdinContent: 'hello from stdin',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout).toBe('hello from stdin')
  })

  it('resolves workDir — pwd outputs expected directory', async () => {
    if (isWindows) return
    const runner = new LocalRunner()
    const cmd: SpawnCommand = {
      binary: 'pwd',
      args: [],
      workDir: '/tmp',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('/tmp')
  })

  it('handles args with special characters via sh -c', async () => {
    if (isWindows) return
    const runner = new LocalRunner()
    const cmd: SpawnCommand = {
      binary: 'sh',
      args: ['-c', 'printf "%s" "hello world"'],
      workDir: WORK_DIR,
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout).toBe('hello world')
  })

  it('receives non-zero exit code on error', async () => {
    if (isWindows) return
    const runner = new LocalRunner()
    const cmd: SpawnCommand = {
      binary: 'sh',
      args: ['-c', 'exit 42'],
      workDir: WORK_DIR,
    }
    const proc = runner.spawn(cmd)
    const { code } = await collect(proc)
    expect(code).toBe(42)
  })
})

// ── WslRunner ─────────────────────────────────────────────────────────────────

let wslAvailable = false
let wslDistro = 'Ubuntu'

beforeAll(() => {
  if (!isWindows) return
  // Detect the default WSL distro name
  const distroResult = spawnSync('wsl', ['echo', '$WSL_DISTRO_NAME'], { encoding: 'utf8', timeout: 5000 })
  const detected = distroResult.stdout.trim()
  if (detected) wslDistro = detected

  const result = spawnSync('wsl', ['-d', wslDistro, '-e', 'echo', 'ok'], { encoding: 'utf8', timeout: 5000 })
  wslAvailable = result.status === 0 && result.stdout.trim() === 'ok'
})

describe('WslRunner — basic spawn', () => {
  it('spawns echo via WSL', async () => {
    if (!isWindows || !wslAvailable) return
    const runner = new WslRunner({ distro: wslDistro })
    const cmd: SpawnCommand = {
      binary: 'echo',
      args: ['hello'],
      workDir: '~',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('hello')
  })

  it('FIX_HOME is applied — $HOME resolves to Linux home (not /mnt/c/...)', async () => {
    if (!isWindows || !wslAvailable) return
    const runner = new WslRunner({ distro: wslDistro })
    const cmd: SpawnCommand = {
      binary: 'sh',
      args: ['-c', 'echo $HOME'],
      workDir: '~',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    // FIX_HOME sets HOME from /etc/passwd — should be a Linux path like /home/...
    expect(stdout.trim()).toMatch(/^\/home\//)
    expect(stdout).not.toContain('/mnt/c/')
  })

  it('preamble is executed before the binary', async () => {
    if (!isWindows || !wslAvailable) return
    // Use a side-effect (temp file) to verify preamble ran — env var inheritance
    // from bash login shells to child sh is unreliable in WSL.
    const tmpFile = '/tmp/wsl_runner_preamble_test'
    const runner = new WslRunner({ distro: wslDistro })
    const cmd: SpawnCommand = {
      binary: 'cat',
      args: [tmpFile],
      workDir: '~',
      preamble: `printf '%s' preamble_ran > ${tmpFile}`,
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout).toBe('preamble_ran')
  })

  it('writes stdinContent to stdin — cat reads it', async () => {
    if (!isWindows || !wslAvailable) return
    const runner = new WslRunner({ distro: wslDistro })
    const cmd: SpawnCommand = {
      binary: 'cat',
      args: [],
      workDir: '~',
      stdinContent: 'hello wsl',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('hello wsl')
  })

  it('workDir: spawns pwd and verifies path', async () => {
    if (!isWindows || !wslAvailable) return
    const runner = new WslRunner({ distro: wslDistro })
    const cmd: SpawnCommand = {
      binary: 'pwd',
      args: [],
      workDir: '/tmp',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('/tmp')
  })
})

// ── SshRunner ─────────────────────────────────────────────────────────────────

let sshAvailable = false

beforeAll(() => {
  const result = spawnSync(
    'ssh',
    ['-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '127.0.0.1', 'echo ok'],
    { encoding: 'utf8', timeout: 5000 }
  )
  sshAvailable = result.status === 0 && result.stdout.trim() === 'ok'
})

describe('SshRunner — basic spawn', () => {
  it('spawns echo via SSH to localhost', async () => {
    if (!sshAvailable) return
    const runner = new SshRunner({ host: '127.0.0.1', user: process.env.USER ?? process.env.USERNAME ?? 'root' })
    const cmd: SpawnCommand = {
      binary: 'echo',
      args: ['hello'],
      workDir: '~',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('hello')
  })

  it('preamble is executed before the binary', async () => {
    if (!sshAvailable) return
    // Use a temp file side-effect to verify preamble ran reliably
    const tmpFile = '/tmp/ssh_runner_preamble_test'
    const runner = new SshRunner({ host: '127.0.0.1', user: process.env.USER ?? process.env.USERNAME ?? 'root' })
    const cmd: SpawnCommand = {
      binary: 'cat',
      args: [tmpFile],
      workDir: '~',
      preamble: `printf '%s' preamble_ran > ${tmpFile}`,
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout).toBe('preamble_ran')
  })

  it('stdin is closed immediately when no stdinContent', async () => {
    if (!sshAvailable) return
    const runner = new SshRunner({ host: '127.0.0.1', user: process.env.USER ?? process.env.USERNAME ?? 'root' })
    // cat will exit immediately when stdin is closed
    const cmd: SpawnCommand = {
      binary: 'cat',
      args: [],
      workDir: '~',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('workDir: cd + pwd produces expected path', async () => {
    if (!sshAvailable) return
    const runner = new SshRunner({ host: '127.0.0.1', user: process.env.USER ?? process.env.USERNAME ?? 'root' })
    const cmd: SpawnCommand = {
      binary: 'pwd',
      args: [],
      workDir: '/tmp',
    }
    const proc = runner.spawn(cmd)
    const { stdout, code } = await collect(proc)
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('/tmp')
  })
})
