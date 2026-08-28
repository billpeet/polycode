import { session, Session } from 'electron'
import { getLocationById } from '../db/queries'
import type { RepoLocation, SshConfig, BrowserSessionConfig } from '../../shared/types'
import { browserPartitionFor, sshLabelFor } from '../../shared/browser'
import { SshTunnelPool } from './port-forward'
import { startBrowserProxy, BrowserProxy } from './proxy-server'

interface ProxyEntry {
  key: string
  ssh: SshConfig
  label: string
  proxy: BrowserProxy
  pool: SshTunnelPool
  teardownTimer: NodeJS.Timeout | null
}

/** A browser session lives a little after its last tab closes, in case the user reopens. */
const TEARDOWN_DELAY_MS = 5_000

/**
 * Binds Browser panels to transport.
 *
 * Every Project Location that opens a Browser gets one persisted Electron
 * session (`persist:browser:{locationId}`), so dev-server cookies and
 * localStorage survive restarts and stay isolated per location. When the
 * location is SSH-backed, that session's loopback traffic is routed through a
 * local proxy which tunnels over the location's own SSH connection — this map
 * owns those proxies and the tunnel pools beneath them, keyed by SSH config so
 * two locations on one host share a proxy.
 *
 * Usage is derived from the set of prepared locations rather than counted:
 * preparing is idempotent per location, so re-preparing can never leak a
 * refcount, and the teardown decision is "does any prepared location still
 * map to this proxy".
 */
class BrowserSessionManager {
  private entries = new Map<string, ProxyEntry>()
  /** In-flight createProxyEntry calls, so concurrent prepares share one proxy. */
  private pendingEntries = new Map<string, Promise<ProxyEntry>>()
  private sessionLocations = new WeakSet<Session>()
  private sessionLocationIds = new WeakMap<Session, string>()
  /** Location ids whose browser session has been prepared (not released). */
  private prepared = new Set<string>()
  /** Location id -> proxy entry key. */
  private locationKeys = new Map<string, string>()
  /** Sessions already configured not to prompt the page for permissions. */
  private hardened = new WeakSet<Session>()

  async prepareSession(locationId: string): Promise<BrowserSessionConfig> {
    const location = getLocationById(locationId)
    if (!location) throw new Error(`Location ${locationId} not found`)

    const partition = browserPartitionFor(locationId)
    const guestSession = session.fromPartition(partition)
    this.sessionLocations.add(guestSession)
    this.sessionLocationIds.set(guestSession, locationId)
    this.hardenSession(guestSession)

    const ssh = sshConfigFor(location)
    if (!ssh) {
      // Local and WSL locations: the browser runs on this machine (WSL2's own
      // localhost forwarding makes local dev servers reachable here already),
      // so Chromium's direct network stack is exactly right.
      await guestSession.setProxy({ mode: 'direct' })
      this.prepared.add(locationId)
      this.locationKeys.delete(locationId)
      return { partition, proxied: false, sshLabel: null }
    }

    const key = proxyKeyFor(ssh)
    if (!this.prepared.has(locationId)) {
      this.prepared.add(locationId)
      this.locationKeys.set(locationId, key)
    }
    const entry = await this.ensureProxyEntry(key, ssh)
    // Route the guest session through our local proxy. `<-loopback>` matters
    // more than it looks: Chromium implicitly *bypasses* proxies for loopback
    // hosts, which would send `localhost:5173` at this machine instead of
    // through the SSH tunnel — negating that is the whole feature. Everything
    // non-loopback also transits the proxy, which relays it direct.
    await guestSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http=127.0.0.1:${entry.proxy.port};https=127.0.0.1:${entry.proxy.port}`,
      proxyBypassRules: '<-loopback>',
    })
    return { partition, proxied: true, sshLabel: entry.label }
  }

  releaseSession(locationId: string): void {
    if (!this.prepared.delete(locationId)) return
    const key = this.locationKeys.get(locationId)
    this.locationKeys.delete(locationId)
    if (!key) return

    const stillUsed = [...this.locationKeys.values()].includes(key)
    if (stillUsed) return

    const entry = this.entries.get(key)
    if (!entry) return
    entry.teardownTimer = setTimeout(() => {
      this.disposeEntry(key)
    }, TEARDOWN_DELAY_MS)
    entry.teardownTimer.unref?.()
  }

  /**
   * Which location a guest webContents belongs to, via its session. Used to
   * route popups (target=_blank) from guest pages back to the right panel.
   */
  locationIdForSession(guestSession: Session): string | null {
    if (!this.sessionLocations.has(guestSession)) return null
    return this.sessionLocationIds.get(guestSession) ?? null
  }

  /**
   * Guest pages are dev servers and docs, not installed apps: deny media,
   * geolocation, notifications and friends without surfacing prompts.
   */
  private hardenSession(guestSession: Session): void {
    if (this.hardened.has(guestSession)) return
    this.hardened.add(guestSession)
    guestSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    guestSession.setPermissionCheckHandler(() => false)
  }

  stopAll(): void {
    for (const key of [...this.entries.keys()]) {
      this.disposeEntry(key)
    }
  }

  private ensureProxyEntry(key: string, ssh: SshConfig): Promise<ProxyEntry> {
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.teardownTimer) {
        clearTimeout(existing.teardownTimer)
        existing.teardownTimer = null
      }
      return Promise.resolve(existing)
    }

    const pending = this.pendingEntries.get(key)
    if (pending) return pending

    const creating = this.createProxyEntry(key, ssh).finally(() => {
      this.pendingEntries.delete(key)
    })
    this.pendingEntries.set(key, creating)
    return creating
  }

  private async createProxyEntry(key: string, ssh: SshConfig): Promise<ProxyEntry> {
    const pool = new SshTunnelPool(ssh)
    try {
      // Binding the proxy is synchronous; the tunnels beneath it spawn lazily
      // per (host, port) on first use, so this resolves immediately.
      const proxy = await startBrowserProxy(pool)
      const entry: ProxyEntry = {
        key,
        ssh,
        label: sshLabelFor(ssh.user, ssh.host),
        proxy,
        pool,
        teardownTimer: null,
      }
      this.entries.set(key, entry)
      return entry
    } catch (err) {
      pool.dispose()
      throw err
    }
  }

  private disposeEntry(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.teardownTimer) {
      clearTimeout(entry.teardownTimer)
      entry.teardownTimer = null
    }
    void entry.proxy.close().then(() => entry.pool.dispose()).catch(() => entry.pool.dispose())
  }
}

function sshConfigFor(location: RepoLocation): SshConfig | null {
  if (location.connection_type !== 'ssh') return null
  return location.ssh ?? null
}

function proxyKeyFor(ssh: SshConfig): string {
  return `${ssh.user}@${ssh.host}:${ssh.port ?? 22}:${ssh.keyPath ?? ''}`
}

export const browserSessionManager = new BrowserSessionManager()
