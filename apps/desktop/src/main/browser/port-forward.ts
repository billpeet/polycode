import { spawn, ChildProcess } from 'child_process'
import * as net from 'net'
import { SshConfig } from '../../shared/types'
import { buildSshBaseArgs } from '../driver/runner'

/**
 * The calling proxy awaits this before it can relay a connection; rejection
 * carries the SSH stderr tail so the browser can show why the page failed.
 */
export interface ForwardHandle {
  /** Local port bound to `host:port` on the remote side. */
  localPort: number
  /** Every client socket opened against the tunnel calls this. */
  retain: () => void
  /** ...and calls this when the socket closes. */
  release: () => void
}

interface Tunnel {
  key: string
  process: ChildProcess
  localPort: number
  stderrTail: string[]
  activeSockets: number
  lastUsedAt: number
}

/** A tunnel with no open sockets and no use for this long is torn down. */
const IDLE_TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000
/** How long acquire() waits for ssh to bind the local listener. */
const BIND_TIMEOUT_MS = 10_000
const STDERR_TAIL_LINES = 8

/**
 * Claim a free loopback port for ssh to bind. Listen-on-ephemeral-then-close
 * is racy in principle; acquire() verifies the tunnel answers before handing
 * the port out, and a collision simply fails that acquire and the next one
 * re-enters the spawn path.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not allocate a local port')))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Poll-connect the local listener; resolves as soon as ssh is bound.
 * `signal.aborted` settles the poll quietly — the loser of the race against
 * process exit must not reject into the void.
 */
function waitForListener(port: number, signal: { aborted: boolean }): Promise<void> {
  const deadline = Date.now() + BIND_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (signal.aborted) {
        resolve()
        return
      }
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) {
          reject(new Error(`SSH tunnel did not open local port ${port} in time`))
          return
        }
        setTimeout(attempt, 150)
      })
    }
    attempt()
  })
}

/**
 * One pool per SSH connection. Lazily spawns `ssh -N -L` processes, one per
 * (host, port) the browser visits — in practice the handful of dev-server
 * ports a session touches — and reaps tunnels the browser stopped using.
 *
 * Uses the same `ssh` binary invocation as every other remote operation in
 * PolyCode (`buildSshBaseArgs`), so ControlMaster multiplexing, key paths and
 * host-key policy behave identically to the Runner and terminal.
 */
export class SshTunnelPool {
  private tunnels = new Map<string, Tunnel>()
  private spawning = new Map<string, Promise<ForwardHandle>>()
  private sweeper: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly ssh: SshConfig) {}

  /**
   * Ensure a live tunnel for `host:port` on the remote side and hand back the
   * local endpoint. Concurrent acquires of the same target share one spawn.
   */
  async acquire(host: string, port: number): Promise<ForwardHandle> {
    if (this.disposed) throw new Error('Tunnel pool is disposed')
    const key = `${host}:${port}`

    const existing = this.tunnels.get(key)
    if (existing) {
      if (this.isAlive(existing)) return this.handleFor(existing)
      this.kill(key, existing.process)
    }

    let pending = this.spawning.get(key)
    if (!pending) {
      pending = this.spawnTunnel(host, port)
      this.spawning.set(key, pending)
      pending.finally(() => {
        if (this.spawning.get(key) === pending) this.spawning.delete(key)
      }).catch(() => { /* rejection is shared below */ })
    }
    return pending
  }

  /** Kill every ssh process; called when the last consumer releases the pool. */
  dispose(): void {
    this.disposed = true
    if (this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    for (const [key, tunnel] of [...this.tunnels.entries()]) {
      this.kill(key, tunnel.process)
    }
  }

  private handleFor(tunnel: Tunnel): ForwardHandle {
    tunnel.lastUsedAt = Date.now()
    this.ensureSweeper()
    return {
      localPort: tunnel.localPort,
      retain: () => {
        tunnel.activeSockets += 1
        tunnel.lastUsedAt = Date.now()
      },
      release: () => {
        tunnel.activeSockets = Math.max(0, tunnel.activeSockets - 1)
        tunnel.lastUsedAt = Date.now()
      },
    }
  }

  private ensureSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const [key, tunnel] of [...this.tunnels.entries()]) {
        if (tunnel.activeSockets === 0 && now - tunnel.lastUsedAt > IDLE_TTL_MS) {
          this.kill(key, tunnel.process)
        }
      }
      if (this.tunnels.size === 0 && this.spawning.size === 0 && this.sweeper) {
        clearInterval(this.sweeper)
        this.sweeper = null
      }
    }, SWEEP_INTERVAL_MS)
    this.sweeper.unref?.()
  }

  private isAlive(tunnel: Tunnel): boolean {
    return tunnel.process.exitCode === null && tunnel.process.signalCode === null
  }

  private kill(key: string, process: ChildProcess): void {
    this.tunnels.delete(key)
    try {
      process.kill()
    } catch {
      // Already gone.
    }
  }

  private async spawnTunnel(host: string, port: number): Promise<ForwardHandle> {
    const localPort = await findFreePort()

    // -N: no remote command, forwards only. ExitOnForwardFailure turns a
    // rejected remote bind (port not listening) into a process exit we can
    // surface, instead of a tunnel that accepts and immediately drops.
    // BatchMode matches the collecting Runner path: an interactive password
    // prompt cannot be answered here, so fail fast instead of hanging.
    const sshArgs = [
      ...buildSshBaseArgs(this.ssh),
      '-N',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      '-L', `127.0.0.1:${localPort}:${host}:${port}`,
      `${this.ssh.user}@${this.ssh.host}`,
    ]

    const child = spawn('ssh', sshArgs, {
      shell: false,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    const tunnel: Tunnel = {
      key: `${host}:${port}`,
      process: child,
      localPort,
      stderrTail: [],
      activeSockets: 0,
      lastUsedAt: Date.now(),
    }

    let onExit: ((code: number | null) => void) | null = null
    const failure = new Promise<never>((_, reject) => {
      onExit = (code) => reject(new Error(
        `SSH tunnel to ${host}:${port} exited (code ${code ?? 'signal'})`
        + (tunnel.stderrTail.length
          ? `: ${tunnel.stderrTail.join('').trim()}`
          : ''),
      ))
    })
    // Marked handled separately from the race: a tunnel that lives a long life
    // and dies of natural causes (dispose, idle reap) must not surface as an
    // unhandled rejection long after acquire() resolved.
    failure.catch(() => { /* consumed by the race or by deliberate teardown */ })

    child.once('exit', (code) => {
      this.tunnels.delete(tunnel.key)
      onExit?.(code)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      tunnel.stderrTail.push(chunk.toString())
      if (tunnel.stderrTail.length > STDERR_TAIL_LINES) tunnel.stderrTail.shift()
    })

    const signal = { aborted: false }
    try {
      await Promise.race([waitForListener(localPort, signal), failure])
    } catch (err) {
      signal.aborted = true
      try { child.kill() } catch { /* already gone */ }
      throw err
    }

    this.tunnels.set(tunnel.key, tunnel)
    return this.handleFor(tunnel)
  }
}
