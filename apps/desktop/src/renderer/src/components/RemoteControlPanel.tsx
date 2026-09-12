import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { RemoteConnectionStatus, RemoteHost, RemoteHostInput, RemotePairingInfo, RemoteServerConfig, TailscaleServeScheme, TailscaleStatus } from '../types/ipc'
import { client } from '../lib/client'
import { writeClipboardText } from '../lib/clipboard'

const DEFAULT_SERVER: RemoteServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 3285,
  token: '',
  webEnabled: false,
  allowedHostnames: [],
}

function parseHostnamesText(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
      style={{ background: on ? 'var(--color-claude)' : 'var(--color-border)' }}
    >
      <div
        className="absolute top-0.5 h-4 w-4 rounded-full transition-transform"
        style={{ background: '#fff', transform: on ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </div>
  )
}

const DEFAULT_FORM: RemoteHostInput = {
  label: '',
  baseUrl: '',
  token: '',
}

interface Props {
  hideHeader?: boolean
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

function inputStyle() {
  return {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text)',
  }
}

function secondaryButtonStyle() {
  return {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
  }
}

/**
 * Mobile pairing QR code for the saved server config. The payload embeds the
 * bearer token, so it stays collapsed behind an explicit reveal toggle.
 */
function PairingQrSection({
  server,
  onBindToAllInterfaces,
}: {
  server: RemoteServerConfig
  onBindToAllInterfaces: () => void
}) {
  const [show, setShow] = useState(false)
  const [info, setInfo] = useState<RemotePairingInfo | null>(null)
  const [selectedIp, setSelectedIp] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const isLoopback = isLoopbackHost(server.host)
  const bindsAll = server.host === '0.0.0.0' || server.host === '::' || server.host === ''
  const pairingIp = !isLoopback && !bindsAll ? server.host : (selectedIp ?? info?.addresses[0] ?? null)

  useEffect(() => {
    if (!show || isLoopback) return
    client
      .invoke('remote:getPairingInfo')
      .then(setInfo)
      .catch(() => setInfo({ addresses: [], hostname: 'PolyCode' }))
  }, [show, isLoopback])

  useEffect(() => {
    if (!show || isLoopback || !pairingIp || !server.token) return
    const params = new URLSearchParams()
    params.set('v', '1')
    params.set('url', `http://${pairingIp}:${server.port}`)
    params.set('token', server.token)
    params.set('name', info?.hostname ?? 'PolyCode')
    const payload = `polycode://pair?${params.toString()}`
    let cancelled = false
    QRCode.toDataURL(payload, { width: 220, margin: 1, color: { dark: '#0f0f0f', light: '#e8e8e8' } })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl)
      })
      .catch(() => setQrDataUrl(null))
    return () => {
      cancelled = true
    }
  }, [show, isLoopback, pairingIp, server.port, server.token, info?.hostname])
  const visibleQrDataUrl = show && !isLoopback && pairingIp && server.token ? qrDataUrl : null

  if (!server.enabled || !server.token) return null

  return (
    <div className="flex flex-col gap-2 rounded px-3 py-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
          Mobile pairing
        </span>
        <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => setShow((v) => !v)}>
          {show ? 'Hide QR' : 'Show pairing QR'}
        </button>
      </div>

      {show && isLoopback && (
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--color-error, #f87171)' }}>
            The server is bound to {server.host} and is unreachable from your phone. Bind it to all interfaces
            (0.0.0.0) and save to enable pairing.
          </p>
          <button
            className="w-fit rounded px-2 py-1 text-xs font-medium"
            style={{ background: 'var(--color-claude)', color: '#fff' }}
            onClick={onBindToAllInterfaces}
          >
            Bind to 0.0.0.0 and save
          </button>
        </div>
      )}

      {show && !isLoopback && (
        <div className="flex flex-col items-start gap-2">
          {bindsAll && (info?.addresses.length ?? 0) > 1 && (
            <div className="flex flex-wrap gap-1">
              {info!.addresses.map((address) => (
                <button
                  key={address}
                  className="rounded px-2 py-0.5 text-xs"
                  style={{
                    ...secondaryButtonStyle(),
                    ...(address === pairingIp ? { borderColor: 'var(--color-claude)', color: 'var(--color-text)' } : {}),
                  }}
                  onClick={() => setSelectedIp(address)}
                >
                  {address}
                </button>
              ))}
            </div>
          )}
          {visibleQrDataUrl && pairingIp ? (
            <>
              <img src={visibleQrDataUrl} alt="PolyCode pairing QR code" className="rounded" width={220} height={220} />
              <p className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                http://{pairingIp}:{server.port}
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Scan with the PolyCode mobile app. The code contains this machine's access token — don't share it.
              </p>
            </>
          ) : (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {info && info.addresses.length === 0
                ? 'No LAN address detected on this machine.'
                : 'Generating…'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const TAILSCALE_UNKNOWN: TailscaleStatus = {
  installed: false,
  running: false,
  dnsName: null,
  tailnetIps: [],
  httpsAvailable: false,
  serve: null,
  error: null,
}

/**
 * One-click exposure over the user's tailnet. The desktop drives `tailscale serve`
 * itself and then rewrites its own server config (allowlist, web access), so the
 * panel's job is to show where things stand and offer the one sensible next step.
 */
function TailscaleSection({ serverPort, onChanged }: { serverPort: number; onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    client.invoke('tailscale:getStatus')
      .then((next) => { if (!cancelled) setStatus(next) })
      .catch((err) => {
        if (!cancelled) setStatus({ ...TAILSCALE_UNKNOWN, error: err instanceof Error ? err.message : String(err) })
      })
    return () => { cancelled = true }
  }, [serverPort])

  async function run(action: () => Promise<TailscaleStatus>): Promise<void> {
    setBusy(true)
    try {
      const next = await action()
      setStatus(next)
      if (!next.error) await onChanged()
    } catch (err) {
      setStatus((current) => ({ ...(current ?? TAILSCALE_UNKNOWN), error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  const expose = (scheme: TailscaleServeScheme): Promise<void> => run(() => client.invoke('tailscale:enableServe', scheme))
  const stop = (): Promise<void> => run(() => client.invoke('tailscale:disableServe'))
  const recheck = (): Promise<void> => run(() => client.invoke('tailscale:getStatus'))

  async function copyUrl(url: string): Promise<void> {
    if (await writeClipboardText(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const primaryButton = { background: 'var(--color-claude)', color: '#fff', opacity: busy ? 0.6 : 1 }

  return (
    <div className="flex flex-col gap-2 rounded px-3 py-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
          Tailscale
        </span>
        {status?.dnsName && (
          <span className="truncate text-xs font-mono" style={{ color: 'var(--color-text-muted)' }} title={status.tailnetIps.join(', ')}>
            {status.dnsName}
          </span>
        )}
      </div>

      {status === null && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Checking…</p>
      )}

      {status && !status.installed && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Tailscale isn't installed on this machine. Install it from tailscale.com to expose PolyCode to your
          tailnet with one click — no port forwarding, and only your devices can reach it.
        </p>
      )}

      {status && status.installed && !status.running && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Tailscale is installed but not running or not signed in.
        </p>
      )}

      {status?.running && status.serve && (
        <div className="flex flex-col gap-2">
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Browsers on your tailnet can open this URL and sign in with the host token above.
            {status.serve.scheme === 'http' && ' Served without TLS: still encrypted by WireGuard, but the browser has no secure context.'}
          </p>
          {status.serve.funnel && (
            <p
              className="rounded px-3 py-2 text-xs"
              style={{ color: 'var(--color-error, #f87171)', border: '1px solid var(--color-error, #f87171)' }}
            >
              Tailscale Funnel is enabled for this port: this URL is reachable from the public internet, not just
              your tailnet. Turn it off with{' '}
              <span className="font-mono">tailscale funnel --{status.serve.scheme}={status.serve.port} off</span>.
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-mono" style={{ color: 'var(--color-text)' }}>{status.serve.url}</span>
            <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => void copyUrl(status.serve!.url)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} disabled={busy} onClick={() => void stop()}>
              Stop serving
            </button>
          </div>
        </div>
      )}

      {status?.running && !status.serve && (
        <div className="flex flex-col gap-2">
          {status.httpsAvailable ? (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Serve PolyCode at https://{status.dnsName} with a certificate from Tailscale. The server keeps listening
              on loopback; only devices on your tailnet can reach it.
            </p>
          ) : (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              HTTPS certificates aren't enabled for your tailnet. Turn them on in the Tailscale admin console under
              DNS → HTTPS Certificates, then recheck — or expose without TLS (encrypted by WireGuard, but the browser
              has no secure context, so clipboard access is limited).
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {status.httpsAvailable ? (
              <button className="rounded px-3 py-1.5 text-xs font-medium" style={primaryButton} disabled={busy} onClick={() => void expose('https')}>
                {busy ? 'Working…' : 'Expose over HTTPS'}
              </button>
            ) : (
              <>
                <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} disabled={busy} onClick={() => void recheck()}>
                  Recheck
                </button>
                <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} disabled={busy} onClick={() => void expose('http')}>
                  {busy ? 'Working…' : 'Expose without TLS'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {status?.error && (
        <p className="text-xs" style={{ color: 'var(--color-error, #f87171)' }}>{status.error}</p>
      )}
    </div>
  )
}

export function RemoteControlPanel({ hideHeader }: Props) {
  const [server, setServer] = useState<RemoteServerConfig>(DEFAULT_SERVER)
  /** Free text while editing; parsed into `allowedHostnames` on save. */
  const [hostnamesText, setHostnamesText] = useState('')
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [activeHost, setActiveHostState] = useState<RemoteHost | null>(null)
  const [form, setForm] = useState<RemoteHostInput>(DEFAULT_FORM)
  const [loading, setLoading] = useState(true)
  const [savingServer, setSavingServer] = useState(false)
  const [savingHost, setSavingHost] = useState(false)
  const [showServerToken, setShowServerToken] = useState(false)
  const [showHostToken, setShowHostToken] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<RemoteConnectionStatus | null>(null)

  useEffect(() => {
    Promise.all([
      client.invoke('remote:getServerConfig'),
      client.invoke('remote:getHosts'),
      client.invoke('remote:getActiveHost'),
    ]).then(([serverConfig, savedHosts, active]) => {
      setServer(serverConfig)
      setHostnamesText(serverConfig.allowedHostnames.join(', '))
      setHosts(savedHosts)
      setActiveHostState(active)
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load remote settings')
    }).finally(() => setLoading(false))
  }, [])

  /** Re-read the server config after something other than this panel changed it. */
  async function reloadServer(): Promise<void> {
    const saved = await client.invoke('remote:getServerConfig')
    setServer(saved)
    setHostnamesText(saved.allowedHostnames.join(', '))
  }

  async function refreshHosts(): Promise<void> {
    const [savedHosts, active] = await Promise.all([
      client.invoke('remote:getHosts'),
      client.invoke('remote:getActiveHost'),
    ])
    setHosts(savedHosts)
    setActiveHostState(active)
  }

  async function saveServer(config?: RemoteServerConfig): Promise<void> {
    const next = { ...(config ?? server), allowedHostnames: parseHostnamesText(hostnamesText) }
    if (next.port < 1024 || next.port > 65535) {
      setError('Port must be between 1024 and 65535')
      return
    }
    setSavingServer(true)
    setError(null)
    setStatus(null)
    try {
      const saved = await client.invoke('remote:setServerConfig', next)
      setServer(saved)
      setHostnamesText(saved.allowedHostnames.join(', '))
      setStatus(saved.enabled ? 'Remote host server is running.' : 'Remote host server is stopped.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save remote host settings')
    } finally {
      setSavingServer(false)
    }
  }

  async function regenerateToken(): Promise<void> {
    setError(null)
    const saved = await client.invoke('remote:regenerateServerToken')
    setServer(saved)
    setStatus('Token regenerated.')
  }

  async function testHost(): Promise<void> {
    setTestResult(null)
    setError(null)
    try {
      const result = await client.invoke('remote:testHost', form)
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Connection failed' })
    }
  }

  async function addHost(): Promise<void> {
    setSavingHost(true)
    setError(null)
    setStatus(null)
    try {
      await client.invoke('remote:addHost', form)
      setForm(DEFAULT_FORM)
      setTestResult(null)
      await refreshHosts()
      setStatus('Remote host saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save remote host')
    } finally {
      setSavingHost(false)
    }
  }

  async function connect(id: string | null): Promise<void> {
    setError(null)
    const active = await client.invoke('remote:setActiveHost', id)
    setActiveHostState(active)
    setStatus(active ? `Connected to ${active.label}.` : 'Remote host disconnected.')
  }

  async function removeHost(id: string): Promise<void> {
    await client.invoke('remote:removeHost', id)
    await refreshHosts()
  }

  if (loading) {
    return <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
  }

  return (
    <div className="flex flex-col gap-5">
      {!hideHeader && (
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Remote Control
        </h2>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            This Machine
          </h3>
          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--color-text)' }}>
            <Toggle on={server.enabled} onToggle={() => setServer((cfg) => ({ ...cfg, enabled: !cfg.enabled }))} />
            {server.enabled ? 'Enabled' : 'Disabled'}
          </label>
        </div>

        <div className="grid grid-cols-[1fr_96px] gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Bind host
            </label>
            <input
              value={server.host}
              onChange={(e) => setServer((cfg) => ({ ...cfg, host: e.target.value }))}
              className="rounded px-2 py-1 text-xs"
              style={inputStyle()}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Port
            </label>
            <input
              type="number"
              min={1024}
              max={65535}
              value={server.port}
              onChange={(e) => setServer((cfg) => ({ ...cfg, port: parseInt(e.target.value, 10) || 3285 }))}
              className="rounded px-2 py-1 text-xs"
              style={inputStyle()}
            />
          </div>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium" style={{ color: 'var(--color-text)' }}>
              Web access
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Serve the PolyCode UI to browsers at http://{server.host}:{server.port}/. Browsers sign in with the host token.
            </span>
          </div>
          <Toggle on={server.webEnabled} onToggle={() => setServer((cfg) => ({ ...cfg, webEnabled: !cfg.webEnabled }))} />
        </div>

        {server.webEnabled && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Allowed hostnames
            </label>
            <input
              value={hostnamesText}
              onChange={(e) => setHostnamesText(e.target.value)}
              placeholder="pc.tailnet.ts.net"
              className="rounded px-2 py-1 text-xs font-mono"
              style={inputStyle()}
            />
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              DNS names accepted in addition to IP addresses, localhost and this machine's name — for example a
              Tailscale MagicDNS name when fronted by <span className="font-mono">tailscale serve</span>. Comma-separated.
            </p>
          </div>
        )}

        <TailscaleSection serverPort={server.port} onChanged={reloadServer} />

        {server.enabled && !isLoopbackHost(server.host) && (
          <p
            className="rounded px-3 py-2 text-xs"
            style={{
              color: 'var(--color-error, #f87171)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-error, #f87171)',
            }}
          >
            Network access uses unencrypted HTTP, so the bearer token can be observed in transit.
            Only enable this on a trusted LAN.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
            Host token
          </label>
          <div className="flex gap-2">
            <input
              type={showServerToken ? 'text' : 'password'}
              value={server.token}
              onChange={(e) => setServer((cfg) => ({ ...cfg, token: e.target.value }))}
              className="min-w-0 flex-1 rounded px-2 py-1 text-xs font-mono"
              style={inputStyle()}
            />
            <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => setShowServerToken((v) => !v)}>
              {showServerToken ? 'Hide' : 'Show'}
            </button>
            <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => void regenerateToken()}>
              Regenerate
            </button>
          </div>
        </div>

        <button
          onClick={() => void saveServer()}
          disabled={savingServer}
          className="w-fit rounded px-3 py-1.5 text-xs font-medium transition-opacity"
          style={{ background: 'var(--color-claude)', color: '#fff', opacity: savingServer ? 0.6 : 1 }}
        >
          {savingServer ? 'Saving...' : 'Save Host Server'}
        </button>

        <PairingQrSection
          server={server}
          onBindToAllInterfaces={() => void saveServer({ ...server, host: '0.0.0.0' })}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            Controlled Hosts
          </h3>
          {activeHost && (
            <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => void connect(null)}>
              Disconnect
            </button>
          )}
        </div>

        {hosts.length === 0 ? (
          <div className="rounded px-3 py-2 text-xs" style={{ ...secondaryButtonStyle(), color: 'var(--color-text-muted)' }}>
            No remote hosts saved.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {hosts.map((host) => {
              const active = activeHost?.id === host.id
              return (
                <div
                  key={host.id}
                  className="flex items-center gap-2 rounded px-3 py-2"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                      {host.label}{active ? ' - connected' : ''}
                    </div>
                    <div className="truncate text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      {host.baseUrl}
                    </div>
                  </div>
                  <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => void connect(active ? null : host.id)}>
                    {active ? 'Disconnect' : 'Connect'}
                  </button>
                  <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => void removeHost(host.id)}>
                    Remove
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <input
            value={form.label}
            onChange={(e) => setForm((value) => ({ ...value, label: e.target.value }))}
            placeholder="Label"
            className="rounded px-2 py-1 text-xs"
            style={inputStyle()}
          />
          <input
            value={form.baseUrl}
            onChange={(e) => setForm((value) => ({ ...value, baseUrl: e.target.value }))}
            placeholder="http://host:3285"
            className="rounded px-2 py-1 text-xs"
            style={inputStyle()}
          />
          <input
            type={showHostToken ? 'text' : 'password'}
            value={form.token}
            onChange={(e) => setForm((value) => ({ ...value, token: e.target.value }))}
            placeholder="Token"
            className="col-span-2 rounded px-2 py-1 text-xs font-mono"
            style={inputStyle()}
          />
        </div>

        <div className="flex items-center gap-2">
          <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => setShowHostToken((v) => !v)}>
            {showHostToken ? 'Hide Token' : 'Show Token'}
          </button>
          <button className="rounded px-2 py-1 text-xs" style={secondaryButtonStyle()} onClick={() => void testHost()}>
            Test
          </button>
          <button
            onClick={() => void addHost()}
            disabled={savingHost}
            className="rounded px-3 py-1 text-xs font-medium"
            style={{ background: 'var(--color-claude)', color: '#fff', opacity: savingHost ? 0.6 : 1 }}
          >
            {savingHost ? 'Saving...' : 'Add Host'}
          </button>
          {testResult && (
            <span className="text-xs" style={{ color: testResult.ok ? 'var(--color-text-muted)' : 'var(--color-error, #f87171)' }}>
              {testResult.ok ? 'Connection OK' : testResult.error}
            </span>
          )}
        </div>
      </section>

      {error && (
        <p className="text-xs" style={{ color: 'var(--color-error, #f87171)' }}>
          {error}
        </p>
      )}
      {status && (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {status}
        </p>
      )}
    </div>
  )
}
