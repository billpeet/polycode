import { useEffect, useState } from 'react'
import { useLocationStore } from '../../stores/locations'
import { ConnectionType, SshConfig, WslConfig } from '../../types/ipc'
import { LocationFormSectionProps } from './types'

export default function LocationFormSection({ projectId, location, pools, gitUrl, onSaved, onCancel }: LocationFormSectionProps) {
  const createLocation = useLocationStore((s) => s.create)
  const updateLocation = useLocationStore((s) => s.update)

  const [label, setLabel] = useState(location?.label ?? '')
  const [path, setPath] = useState(location?.path ?? '')
  const [poolId, setPoolId] = useState<string>(location?.pool_id ?? '')
  const [connectionType, setConnectionType] = useState<ConnectionType>(location?.connection_type ?? 'local')
  const [sshHost, setSshHost] = useState(location?.ssh?.host ?? '')
  const [sshUser, setSshUser] = useState(location?.ssh?.user ?? '')
  const [sshPort, setSshPort] = useState(location?.ssh?.port?.toString() ?? '')
  const [sshKeyPath, setSshKeyPath] = useState(location?.ssh?.keyPath ?? '')
  const [wslDistro, setWslDistro] = useState(location?.wsl?.distro ?? '')
  const [availableDistros, setAvailableDistros] = useState<string[]>([])
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'success' | 'fail' | null>(null)
  const [cloneMode, setCloneMode] = useState(false)
  const [baseDir, setBaseDir] = useState('~/source')
  const [suggestedPath, setSuggestedPath] = useState('')
  const [cloneLabel, setCloneLabel] = useState('')
  const [cloning, setCloning] = useState(false)
  const [cloneError, setCloneError] = useState('')

  useEffect(() => {
    if (!cloneMode) return
    window.api.invoke('settings:get', 'default_source_dir').then((val) => {
      setBaseDir(val ?? '~/source')
    }).catch(() => {})
  }, [cloneMode])

  useEffect(() => {
    if (!cloneMode || !gitUrl) {
      setSuggestedPath('')
      return
    }
    const repoName = gitUrl.replace(/\.git$/, '').split('/').filter(Boolean).pop() ?? 'repo'
    if (!cloneLabel) setCloneLabel(repoName)
    window.api.invoke('locations:suggestPath', baseDir, repoName).then(setSuggestedPath).catch(() => {})
  }, [cloneMode, baseDir, gitUrl, cloneLabel])

  const isSSH = connectionType === 'ssh'
  const isWSL = connectionType === 'wsl'

  useEffect(() => {
    if (!isWSL) return
    window.api.invoke('wsl:list-distros').then((distros) => {
      setAvailableDistros(distros)
      if (!wslDistro && distros.length > 0) setWslDistro(distros[0])
    }).catch(() => setAvailableDistros([]))
  }, [isWSL, wslDistro])

  function buildSshConfig(): SshConfig | null {
    if (!isSSH) return null
    return {
      host: sshHost.trim(),
      user: sshUser.trim(),
      port: sshPort ? parseInt(sshPort, 10) : undefined,
      keyPath: sshKeyPath.trim() || undefined,
    }
  }

  function buildWslConfig(): WslConfig | null {
    if (!isWSL) return null
    return { distro: wslDistro.trim() }
  }

  const canTest = (isSSH && sshHost.trim() && sshUser.trim() && path.trim()) || (isWSL && wslDistro.trim() && path.trim())

  async function handleClone(): Promise<void> {
    if (!gitUrl || !suggestedPath) return
    const labelToUse = cloneLabel.trim() || suggestedPath.split(/[/\\]/).pop() || 'Local'
    setCloning(true)
    setCloneError('')
    try {
      await window.api.invoke('locations:clone', projectId, labelToUse, gitUrl, suggestedPath)
      onSaved()
    } catch (err) {
      setCloneError(String(err).replace(/^Error:\s*/, ''))
    }
    setCloning(false)
  }

  function handleSetAsDefault(): void {
    window.api.invoke('settings:set', 'default_source_dir', baseDir).catch(() => {})
  }

  async function handleTest(): Promise<void> {
    setError('')
    setTesting(true)
    setTestResult(null)
    try {
      if (isSSH) {
        const ssh = buildSshConfig()
        if (!ssh || !path.trim()) return
        const result = await window.api.invoke('ssh:test', ssh, path.trim())
        setTestResult(result.ok ? 'success' : 'fail')
        if (!result.ok) setError(`SSH connection failed: ${result.error}`)
      } else if (isWSL) {
        const wsl = buildWslConfig()
        if (!wsl || !path.trim()) return
        const result = await window.api.invoke('wsl:test', wsl, path.trim())
        setTestResult(result.ok ? 'success' : 'fail')
        if (!result.ok) setError(`WSL test failed: ${result.error}`)
      }
    } catch (err) {
      setTestResult('fail')
      setError(`Test error: ${String(err)}`)
    }
    setTesting(false)
  }

  async function handleBrowse(): Promise<void> {
    const dir = await window.api.invoke('dialog:open-directory')
    if (dir) {
      setPath(dir)
      if (!label) {
        const parts = dir.split(/[/\\]/)
        setLabel(parts[parts.length - 1] || 'Local')
      }
    }
  }

  async function handleSave(): Promise<void> {
    if (!label.trim()) { setError('Label is required'); return }
    if (!path.trim()) { setError('Path is required'); return }
    if (isSSH && !sshHost.trim()) { setError('SSH host is required'); return }
    if (isSSH && !sshUser.trim()) { setError('SSH user is required'); return }
    if (isWSL && !wslDistro.trim()) { setError('WSL distro is required'); return }

    const ssh = buildSshConfig()
    const wsl = buildWslConfig()

    if (ssh) {
      setError('')
      setTesting(true)
      setTestResult(null)
      try {
        const result = await window.api.invoke('ssh:test', ssh, path.trim())
        if (!result.ok) {
          setTestResult('fail')
          setError(`SSH connection failed: ${result.error}`)
          setTesting(false)
          return
        }
        setTestResult('success')
      } catch (err) {
        setTestResult('fail')
        setError(`SSH test error: ${String(err)}`)
        setTesting(false)
        return
      }
      setTesting(false)
    } else if (wsl) {
      setError('')
      setTesting(true)
      setTestResult(null)
      try {
        const result = await window.api.invoke('wsl:test', wsl, path.trim())
        if (!result.ok) {
          setTestResult('fail')
          setError(`WSL test failed: ${result.error}`)
          setTesting(false)
          return
        }
        setTestResult('success')
      } catch (err) {
        setTestResult('fail')
        setError(`WSL test error: ${String(err)}`)
        setTesting(false)
        return
      }
      setTesting(false)
    }

    try {
      if (location) {
        await updateLocation(location.id, projectId, label.trim(), connectionType, path.trim(), poolId || null, ssh, wsl)
      } else {
        await createLocation(projectId, label.trim(), connectionType, path.trim(), poolId || null, ssh, wsl)
      }
      onSaved()
    } catch (err) {
      setError(String(err))
    }
  }

  const toggleStyle = (active: boolean) => ({
    background: active ? 'var(--color-claude)' : 'var(--color-surface)',
    color: active ? '#fff' : 'var(--color-text-muted)',
    border: `1px solid ${active ? 'var(--color-claude)' : 'var(--color-border)'}`,
  })

  const pathLabel = isSSH ? 'Remote Path' : isWSL ? 'WSL Path' : 'Directory'
  const pathPlaceholder = isSSH ? '/home/user/project' : isWSL ? '~/projects/myapp' : '/path/to/project'

  return (
    <div className="mt-1.5 rounded-md p-3 space-y-2.5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
      <div>
        <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Connection</label>
        <div className="flex gap-1">
          {(['local', 'ssh', 'wsl'] as ConnectionType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => { setConnectionType(type); setTestResult(null); setError(''); if (type !== 'local') setCloneMode(false) }}
              className="flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors"
              style={toggleStyle(connectionType === type)}
            >
              {type === 'local' ? 'Local' : type === 'ssh' ? 'SSH Remote' : 'WSL'}
            </button>
          ))}
        </div>
      </div>

      {!location && connectionType === 'local' && (
        <div>
          <div className="flex gap-1">
            <button type="button" onClick={() => { setCloneMode(false); setCloneError('') }} className="flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors" style={toggleStyle(!cloneMode)}>
              Use Existing
            </button>
            <button type="button" onClick={() => { setCloneMode(true); setError('') }} className="flex-1 rounded px-2 py-1.5 text-xs font-medium transition-colors" style={toggleStyle(cloneMode)}>
              Clone New
            </button>
          </div>
        </div>
      )}

      {cloneMode && !location && (
        <>
          {!gitUrl ? (
            <p className="text-xs py-1" style={{ color: '#f87171' }}>Set a Git URL on the project before cloning.</p>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Label</label>
                <input type="text" value={cloneLabel} onChange={(e) => setCloneLabel(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="Local" autoFocus />
              </div>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Base directory</label>
                <div className="flex gap-2 items-center">
                  <input type="text" value={baseDir} onChange={(e) => setBaseDir(e.target.value)} className="flex-1 rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="~/source" />
                  <button type="button" onClick={handleSetAsDefault} className="rounded px-2.5 py-1.5 text-xs whitespace-nowrap" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }} title="Save as default base directory">
                    Set default
                  </button>
                </div>
              </div>
              {suggestedPath && (
                <div>
                  <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Clone path</label>
                  <div className="rounded px-3 py-1.5 text-sm font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
                    {suggestedPath}
                  </div>
                </div>
              )}
            </>
          )}
          {cloneError && <p className="text-xs" style={{ color: '#f87171' }}>{cloneError}</p>}
          <div className="flex justify-end gap-2 pt-0.5">
            <button type="button" onClick={onCancel} disabled={cloning} className="rounded px-3 py-1.5 text-xs" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              Cancel
            </button>
            <button type="button" onClick={handleClone} disabled={!gitUrl || !suggestedPath || cloning} className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50" style={{ background: 'var(--color-claude)', color: '#fff' }}>
              {cloning ? <span className="flex items-center gap-1.5"><span className="streaming-dot" style={{ background: '#fff', width: 5, height: 5 }} />Cloning...</span> : 'Clone'}
            </button>
          </div>
        </>
      )}

      {!cloneMode && (
        <>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Label</label>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder={isSSH ? 'SSH Prod' : isWSL ? 'WSL Ubuntu' : 'Local'} autoFocus />
          </div>
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Location Pool <span style={{ opacity: 0.5 }}>(optional)</span></label>
            <select value={poolId} onChange={(e) => setPoolId(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
              <option value="">No pool</option>
              {pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
            </select>
          </div>
          {isSSH && (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Host</label>
                  <input type="text" value={sshHost} onChange={(e) => setSshHost(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="example.com" />
                </div>
                <div style={{ width: 72 }}>
                  <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Port</label>
                  <input type="number" value={sshPort} onChange={(e) => setSshPort(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="22" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>User</label>
                <input type="text" value={sshUser} onChange={(e) => setSshUser(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="ubuntu" />
              </div>
              <div>
                <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Key Path <span style={{ opacity: 0.5 }}>(optional)</span></label>
                <input type="text" value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="~/.ssh/id_rsa" />
              </div>
            </>
          )}
          {isWSL && (
            <div>
              <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>Distro</label>
              {availableDistros.length > 0 ? (
                <select value={wslDistro} onChange={(e) => setWslDistro(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                  {availableDistros.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              ) : (
                <input type="text" value={wslDistro} onChange={(e) => setWslDistro(e.target.value)} className="w-full rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder="Ubuntu" />
              )}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs" style={{ color: 'var(--color-text-muted)' }}>{pathLabel}</label>
            <div className="flex gap-2">
              <input type="text" value={path} onChange={(e) => setPath(e.target.value)} className="flex-1 rounded px-3 py-1.5 text-sm outline-none font-mono" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }} placeholder={pathPlaceholder} />
              {!isSSH && !isWSL && <button type="button" onClick={handleBrowse} className="rounded px-3 py-1.5 text-xs" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>Browse</button>}
            </div>
          </div>
          {(isSSH || isWSL) && (
            <div className="flex items-center gap-2">
              <button type="button" onClick={handleTest} disabled={!canTest || testing} className="rounded px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              {testing && <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}><span className="streaming-dot" style={{ background: 'var(--color-claude)', width: 6, height: 6 }} />{isWSL ? 'Testing WSL...' : 'Connecting...'}</span>}
              {!testing && testResult === 'success' && <span className="text-xs font-medium" style={{ color: '#4ade80' }}>{isWSL ? 'Path valid' : 'Connected'}</span>}
              {!testing && testResult === 'fail' && <span className="text-xs font-medium" style={{ color: '#f87171' }}>Failed</span>}
            </div>
          )}
          {error && <p className="text-xs" style={{ color: '#f87171' }}>{error}</p>}
          <div className="flex justify-end gap-2 pt-0.5">
            <button type="button" onClick={onCancel} disabled={testing} className="rounded px-3 py-1.5 text-xs" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}>Cancel</button>
            <button type="button" onClick={handleSave} disabled={testing} className="rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50" style={{ background: 'var(--color-claude)', color: '#fff' }}>{testing ? 'Testing...' : location ? 'Save' : 'Add'}</button>
          </div>
        </>
      )}
    </div>
  )
}
