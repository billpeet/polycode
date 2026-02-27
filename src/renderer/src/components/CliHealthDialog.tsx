import { useState, useEffect, useCallback } from 'react'
import { useLocationStore } from '../stores/locations'
import { useProjectStore } from '../stores/projects'
import { Provider, PROVIDERS, SshConfig, WslConfig, CliHealthResult, CliUpdateResult } from '../types/ipc'

interface EnvironmentOption {
  label: string
  connectionType: string
  ssh?: SshConfig | null
  wsl?: WslConfig | null
}

interface ProviderStatus {
  loading: boolean
  result: CliHealthResult | null
  error?: string
  updating: boolean
  updateResult: CliUpdateResult | null
  showOutput: boolean
}

const EMPTY_STATUS: ProviderStatus = {
  loading: false,
  result: null,
  updating: false,
  updateResult: null,
  showOutput: false,
}

const PROVIDER_LABELS: Record<Provider, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
}

interface Props {
  onClose: () => void
}

export default function CliHealthDialog({ onClose }: Props) {
  const byProject = useLocationStore((s) => s.byProject)
  const fetchLocations = useLocationStore((s) => s.fetch)
  const projects = useProjectStore((s) => s.projects)

  // Ensure locations are loaded for every project so SSH/WSL environments appear
  // even if the user hasn't expanded those projects in the sidebar yet.
  useEffect(() => {
    for (const project of projects) {
      if (!byProject[project.id]) {
        fetchLocations(project.id)
      }
    }
  }, [projects]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build environment options: Local + all SSH/WSL locations
  const environmentOptions: EnvironmentOption[] = [
    { label: 'Local', connectionType: 'local' },
  ]
  for (const locations of Object.values(byProject)) {
    for (const loc of locations) {
      if (loc.connection_type === 'ssh' && loc.ssh) {
        const projectName = projects.find((p) => p.id === loc.project_id)?.name
        environmentOptions.push({
          label: `${projectName ? `${projectName} / ` : ''}${loc.label} (SSH)`,
          connectionType: 'ssh',
          ssh: loc.ssh,
        })
      } else if (loc.connection_type === 'wsl' && loc.wsl) {
        const projectName = projects.find((p) => p.id === loc.project_id)?.name
        environmentOptions.push({
          label: `${projectName ? `${projectName} / ` : ''}${loc.label} (WSL)`,
          connectionType: 'wsl',
          wsl: loc.wsl,
        })
      }
    }
  }

  const [selectedEnvIdx, setSelectedEnvIdx] = useState(0)
  const [statuses, setStatuses] = useState<Record<Provider, ProviderStatus>>({
    'claude-code': { ...EMPTY_STATUS },
    'codex': { ...EMPTY_STATUS },
    'opencode': { ...EMPTY_STATUS },
  })

  const selectedEnv = environmentOptions[selectedEnvIdx] ?? environmentOptions[0]

  const checkAll = useCallback(async () => {
    const env = environmentOptions[selectedEnvIdx] ?? environmentOptions[0]

    // Reset all to loading
    setStatuses({
      'claude-code': { ...EMPTY_STATUS, loading: true },
      'codex': { ...EMPTY_STATUS, loading: true },
      'opencode': { ...EMPTY_STATUS, loading: true },
    })

    // Check all providers in parallel
    await Promise.all(
      PROVIDERS.map(async ({ id: provider }) => {
        try {
          const result = await window.api.invoke(
            'cli:health',
            provider,
            env.connectionType,
            env.ssh ?? null,
            env.wsl ?? null,
          )
          setStatuses((prev) => ({
            ...prev,
            [provider]: { ...EMPTY_STATUS, result },
          }))
        } catch (err) {
          setStatuses((prev) => ({
            ...prev,
            [provider]: { ...EMPTY_STATUS, error: String(err) },
          }))
        }
      })
    )
  }, [selectedEnvIdx, environmentOptions.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Run check on mount and env change
  useEffect(() => {
    checkAll()
  }, [checkAll])

  async function handleUpdate(provider: Provider): Promise<void> {
    setStatuses((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], updating: true, updateResult: null, showOutput: false },
    }))

    try {
      const result = await window.api.invoke(
        'cli:update',
        provider,
        selectedEnv.connectionType,
        selectedEnv.ssh ?? null,
        selectedEnv.wsl ?? null,
      )
      setStatuses((prev) => ({
        ...prev,
        [provider]: { ...prev[provider], updating: false, updateResult: result, showOutput: true },
      }))

      // Re-check this provider after update
      if (result.success) {
        const health = await window.api.invoke(
          'cli:health',
          provider,
          selectedEnv.connectionType,
          selectedEnv.ssh ?? null,
          selectedEnv.wsl ?? null,
        )
        setStatuses((prev) => ({
          ...prev,
          [provider]: { ...prev[provider], result: health },
        }))
      }
    } catch (err) {
      setStatuses((prev) => ({
        ...prev,
        [provider]: {
          ...prev[provider],
          updating: false,
          updateResult: { success: false, output: String(err) },
          showOutput: true,
        },
      }))
    }
  }

  function versionBadge(status: ProviderStatus) {
    if (status.loading) {
      return <span style={{ color: 'var(--color-text-muted)' }}>Checking…</span>
    }
    if (status.error) {
      return <span style={{ color: '#f87171' }}>Error</span>
    }
    if (!status.result) return null
    const { installed, currentVersion, latestVersion, upToDate } = status.result
    if (!installed) {
      return <span style={{ color: '#f87171' }}>Not installed</span>
    }
    if (upToDate === true) {
      return (
        <span style={{ color: '#4ade80' }}>
          v{currentVersion} — up to date
        </span>
      )
    }
    if (upToDate === false) {
      return (
        <span style={{ color: '#fbbf24' }}>
          v{currentVersion}
          {latestVersion ? ` — latest v${latestVersion}` : ''}
        </span>
      )
    }
    // installed but can't determine latest
    return (
      <span style={{ color: 'var(--color-text-muted)' }}>
        v{currentVersion}
        {latestVersion === null ? ' — (offline)' : ''}
      </span>
    )
  }

  function statusIcon(status: ProviderStatus) {
    if (status.loading) return <span style={{ opacity: 0.4 }}>●</span>
    if (status.error || (status.result && !status.result.installed)) return <span style={{ color: '#f87171' }}>✗</span>
    if (status.result?.upToDate === false) return <span style={{ color: '#fbbf24' }}>↑</span>
    if (status.result?.installed) return <span style={{ color: '#4ade80' }}>✓</span>
    return null
  }

  const isChecking = Object.values(statuses).some((s) => s.loading)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="w-[480px] rounded-lg p-6 shadow-2xl"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
            CLI Health
          </h2>
          <button
            onClick={onClose}
            className="text-xs opacity-50 hover:opacity-100 transition-opacity"
            style={{ color: 'var(--color-text-muted)' }}
          >
            ✕
          </button>
        </div>

        {/* Environment selector */}
        {environmentOptions.length > 1 && (
          <div className="mb-4">
            <label className="block text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Environment
            </label>
            <select
              value={selectedEnvIdx}
              onChange={(e) => setSelectedEnvIdx(Number(e.target.value))}
              disabled={isChecking}
              className="w-full rounded px-3 py-1.5 text-sm outline-none"
              style={{
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
              }}
            >
              {environmentOptions.map((env, idx) => (
                <option key={idx} value={idx}>{env.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Provider list */}
        <div className="space-y-3">
          {PROVIDERS.map(({ id: provider }) => {
            const status = statuses[provider]
            const canUpdate = !status.loading && !status.updating &&
              status.result?.installed === true && status.result?.upToDate === false

            return (
              <div
                key={provider}
                className="rounded p-3"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm w-3 text-center flex-shrink-0">
                      {statusIcon(status)}
                    </span>
                    <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                      {PROVIDER_LABELS[provider]}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono">{versionBadge(status)}</span>
                    {status.updating && (
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        Updating…
                      </span>
                    )}
                    {canUpdate && (
                      <button
                        onClick={() => handleUpdate(provider)}
                        className="rounded px-2 py-0.5 text-xs font-medium transition-colors"
                        style={{
                          background: 'var(--color-claude)',
                          color: '#fff',
                        }}
                      >
                        Update
                      </button>
                    )}
                    {status.updateResult && !status.updating && (
                      <button
                        onClick={() =>
                          setStatuses((prev) => ({
                            ...prev,
                            [provider]: { ...prev[provider], showOutput: !prev[provider].showOutput },
                          }))
                        }
                        className="text-xs opacity-50 hover:opacity-100 transition-opacity"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        {status.showOutput ? 'Hide output' : 'Show output'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Error detail */}
                {status.error && (
                  <p className="mt-1.5 text-xs" style={{ color: '#f87171' }}>{status.error}</p>
                )}

                {/* Update output */}
                {status.showOutput && status.updateResult && (
                  <pre
                    className="mt-2 rounded p-2 text-xs overflow-x-auto max-h-32 overflow-y-auto"
                    style={{
                      background: 'var(--color-surface-2)',
                      border: '1px solid var(--color-border)',
                      color: status.updateResult.success ? '#4ade80' : '#f87171',
                      fontFamily: 'monospace',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {status.updateResult.output || (status.updateResult.success ? 'Done.' : 'Failed.')}
                  </pre>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center mt-4 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <button
            onClick={checkAll}
            disabled={isChecking}
            className="rounded px-3 py-1.5 text-xs transition-colors disabled:opacity-40"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          >
            {isChecking ? 'Checking…' : 'Check again'}
          </button>
          <button
            onClick={onClose}
            className="rounded px-4 py-1.5 text-xs"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
