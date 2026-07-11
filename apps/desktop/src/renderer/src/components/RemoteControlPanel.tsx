import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { RemoteConnectionStatus, RemoteHost, RemoteHostInput, RemotePairingInfo, RemoteServerConfig } from '../types/ipc'

const DEFAULT_SERVER: RemoteServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 3285,
  token: '',
}

const DEFAULT_FORM: RemoteHostInput = {
  label: '',
  baseUrl: '',
  token: '',
}

interface Props {
  hideHeader?: boolean
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

  const isLoopback = server.host === '127.0.0.1' || server.host === 'localhost' || server.host === '::1'
  const bindsAll = server.host === '0.0.0.0' || server.host === '::' || server.host === ''
  const pairingIp = !isLoopback && !bindsAll ? server.host : (selectedIp ?? info?.addresses[0] ?? null)

  useEffect(() => {
    if (!show || isLoopback) return
    window.api
      .invoke('remote:getPairingInfo')
      .then(setInfo)
      .catch(() => setInfo({ addresses: [], hostname: 'PolyCode' }))
  }, [show, isLoopback])

  useEffect(() => {
    if (!show || isLoopback || !pairingIp || !server.token) {
      setQrDataUrl(null)
      return
    }
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
          {qrDataUrl && pairingIp ? (
            <>
              <img src={qrDataUrl} alt="PolyCode pairing QR code" className="rounded" width={220} height={220} />
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

export function RemoteControlPanel({ hideHeader }: Props) {
  const [server, setServer] = useState<RemoteServerConfig>(DEFAULT_SERVER)
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
      window.api.invoke('remote:getServerConfig'),
      window.api.invoke('remote:getHosts'),
      window.api.invoke('remote:getActiveHost'),
    ]).then(([serverConfig, savedHosts, active]) => {
      setServer(serverConfig)
      setHosts(savedHosts)
      setActiveHostState(active)
    }).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load remote settings')
    }).finally(() => setLoading(false))
  }, [])

  async function refreshHosts(): Promise<void> {
    const [savedHosts, active] = await Promise.all([
      window.api.invoke('remote:getHosts'),
      window.api.invoke('remote:getActiveHost'),
    ])
    setHosts(savedHosts)
    setActiveHostState(active)
  }

  async function saveServer(config?: RemoteServerConfig): Promise<void> {
    const next = config ?? server
    if (next.port < 1024 || next.port > 65535) {
      setError('Port must be between 1024 and 65535')
      return
    }
    setSavingServer(true)
    setError(null)
    setStatus(null)
    try {
      const saved = await window.api.invoke('remote:setServerConfig', next)
      setServer(saved)
      setStatus(saved.enabled ? 'Remote host server is running.' : 'Remote host server is stopped.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save remote host settings')
    } finally {
      setSavingServer(false)
    }
  }

  async function regenerateToken(): Promise<void> {
    setError(null)
    const saved = await window.api.invoke('remote:regenerateServerToken')
    setServer(saved)
    setStatus('Token regenerated.')
  }

  async function testHost(): Promise<void> {
    setTestResult(null)
    setError(null)
    try {
      const result = await window.api.invoke('remote:testHost', form)
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
      await window.api.invoke('remote:addHost', form)
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
    const active = await window.api.invoke('remote:setActiveHost', id)
    setActiveHostState(active)
    setStatus(active ? `Connected to ${active.label}.` : 'Remote host disconnected.')
  }

  async function removeHost(id: string): Promise<void> {
    await window.api.invoke('remote:removeHost', id)
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
            <div
              onClick={() => setServer((cfg) => ({ ...cfg, enabled: !cfg.enabled }))}
              className="relative h-5 w-9 rounded-full transition-colors"
              style={{ background: server.enabled ? 'var(--color-claude)' : 'var(--color-border)' }}
            >
              <div
                className="absolute top-0.5 h-4 w-4 rounded-full transition-transform"
                style={{ background: '#fff', transform: server.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
              />
            </div>
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
