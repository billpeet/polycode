// Not yet behind Runner, for two reasons that are specific to connection testing:
//
// 1. wsl.exe reports its OWN failures (unknown distro, WSL not installed) in
//    UTF-16LE, which is exactly the case these functions exist to report.
//    decodeWslBuffer sniffs for it; collectProcess decodes utf8 unconditionally,
//    so routing this through the seam would turn the useful error into mojibake.
// 2. SshRunner.runScript prepends LOAD_NODE_MANAGERS, which sources nvm and
//    friends on the remote host. A `test -d` probe should not pay for that —
//    this runs while the user is typing a host into a form.
//
// The shell quoting IS shared: quoteShellPath was a fourth private copy of
// cdTarget and is gone.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { spawn } from 'node:child_process'
import type { SshConfig, WslConfig } from '../shared/types'
import { cdTarget } from './driver/runner'

export interface ConnectionTestResult {
  ok: boolean
  error?: string
}

let cachedWslDistros: { expiresAt: number; value: string[] } | null = null

/** Decode either UTF-8 bash output or UTF-16LE output emitted by wsl.exe itself. */
function decodeWslBuffer(buf: Buffer): string {
  if (buf.length === 0) return ''
  if (buf.length >= 2 && buf[1] === 0) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '').trim()
  }
  return buf.toString('utf8').trim()
}

export function testSshConnection(ssh: SshConfig, remotePath: string): Promise<ConnectionTestResult> {
  return new Promise((resolve) => {
    const sshArgs = [
      '-T',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
    ]
    if (ssh.port) sshArgs.push('-p', String(ssh.port))
    if (ssh.keyPath) sshArgs.push('-i', ssh.keyPath)
    sshArgs.push(`${ssh.user}@${ssh.host}`, `test -d ${cdTarget(remotePath)} && echo __POLYCODE_OK__`)

    const proc = spawn('ssh', sshArgs, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('__POLYCODE_OK__')) resolve({ ok: true })
      else resolve({ ok: false, error: stderr.trim() || `SSH exited with code ${code}` })
    })
    proc.on('error', (err) => resolve({ ok: false, error: err.message }))
  })
}

export function testWslConnection(wsl: WslConfig, wslPath: string): Promise<ConnectionTestResult> {
  return new Promise((resolve) => {
    const innerCmd = `test -d ${cdTarget(wslPath)} && echo __POLYCODE_OK__`
    const proc = spawn('wsl', ['-d', wsl.distro, '--', 'bash', '-ilc', innerCmd], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
    proc.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })
    proc.on('close', (code) => {
      const stdout = decodeWslBuffer(Buffer.concat(stdoutChunks))
      const stderr = decodeWslBuffer(Buffer.concat(stderrChunks))
      if (code === 0 && stdout.includes('__POLYCODE_OK__')) resolve({ ok: true })
      else resolve({ ok: false, error: stderr || (code === 1 ? 'Directory not found in WSL distro' : `WSL exited with code ${code}`) })
    })
    proc.on('error', (err) => resolve({ ok: false, error: err.message }))
  })
}

export function listWslDistros(): Promise<string[]> {
  if (cachedWslDistros && cachedWslDistros.expiresAt > Date.now()) {
    return Promise.resolve(cachedWslDistros.value)
  }
  return new Promise((resolve) => {
    const proc = spawn('wsl', ['--list', '--quiet'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    })
    const stdoutChunks: Buffer[] = []
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
    proc.on('close', (code) => {
      if (code !== 0) return resolve([])
      const distros = decodeWslBuffer(Buffer.concat(stdoutChunks)).split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
      cachedWslDistros = { value: distros, expiresAt: Date.now() + 10 * 60_000 }
      resolve(distros)
    })
    proc.on('error', () => resolve([]))
  })
}
