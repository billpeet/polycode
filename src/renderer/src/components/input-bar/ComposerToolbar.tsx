import { Thread, PROVIDERS, Provider, getDefaultModelForProvider, getModelsForProvider } from '../../types/ipc'
import CliHealthIndicator from './CliHealthIndicator'
import { PlanIcon, YoloIcon, formatElapsed } from './icons'

interface ComposerToolbarProps {
  threadId: string
  planMode: boolean
  setPlanMode: (threadId: string, value: boolean) => void
  isProcessing: boolean
  isLocalLocation: boolean | undefined
  currentThread: Thread | undefined
  availableDistros: string[]
  setYolo: (threadId: string, yoloMode: boolean) => void
  setWsl: (threadId: string, useWsl: boolean, distro: string | null) => void
  setProviderAndModel: (threadId: string, provider: Provider, model: string) => void
  setModel: (threadId: string, model: string) => void
  showCodexWslWarning: boolean
  elapsedSeconds: number
}

export default function ComposerToolbar({
  threadId,
  planMode,
  setPlanMode,
  isProcessing,
  isLocalLocation,
  currentThread,
  availableDistros,
  setYolo,
  setWsl,
  setProviderAndModel,
  setModel,
  showCodexWslWarning,
  elapsedSeconds,
}: ComposerToolbarProps) {
  const supportsYolo = currentThread?.provider === 'claude-code' || currentThread?.provider === 'codex'

  return (
    <div className="flex items-center gap-2 px-3 pt-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <button
        onClick={() => setPlanMode(threadId, !planMode)}
        disabled={isProcessing}
        title={planMode ? 'Plan mode: ON - Claude will create a plan before executing' : 'Plan mode: OFF - Claude will execute directly'}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-30 mb-2"
        style={{
          background: planMode ? 'rgba(232, 123, 95, 0.15)' : 'transparent',
          color: planMode ? 'var(--color-claude)' : 'var(--color-text-muted)',
          border: `1px solid ${planMode ? 'rgba(232, 123, 95, 0.3)' : 'transparent'}`,
        }}
      >
        <PlanIcon />
        Plan
      </button>
      <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>|</span>
      {supportsYolo && currentThread && (
        <>
          <button
            onClick={() => setYolo(threadId, !currentThread.yolo_mode)}
            disabled={isProcessing}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-30 mb-2"
            title={currentThread.provider === 'codex'
              ? 'Codex Yolo: bypass approvals and sandbox'
              : 'Claude Yolo: skip permissions prompts'}
            style={{
              background: currentThread.yolo_mode ? 'rgba(249, 115, 22, 0.15)' : 'transparent',
              color: currentThread.yolo_mode ? '#f97316' : 'var(--color-text-muted)',
              border: `1px solid ${currentThread.yolo_mode ? 'rgba(249, 115, 22, 0.3)' : 'transparent'}`,
            }}
          >
            <YoloIcon />
            Yolo
          </button>
          <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>|</span>
        </>
      )}
      <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
        Shift+Enter for newline
      </span>

      <span className="flex-1" />

      {isLocalLocation && currentThread && availableDistros.length > 0 && (
        <span className="flex items-center gap-1 flex-shrink-0 mb-2">
          <label
            className="flex items-center gap-1 text-xs cursor-pointer select-none"
            style={{
              color: currentThread.use_wsl ? '#fbbf24' : 'var(--color-text-muted)',
              opacity: currentThread.has_messages ? 0.4 : 1,
            }}
            title={currentThread.has_messages ? 'WSL setting is locked after first message' : 'Run CLI via WSL'}
          >
            <input
              type="checkbox"
              checked={currentThread.use_wsl}
              disabled={currentThread.has_messages}
              onChange={(e) => {
                const checked = e.target.checked
                const distro = checked ? (currentThread.wsl_distro ?? availableDistros[0] ?? null) : null
                setWsl(threadId, checked, distro)
              }}
              className="accent-yellow-400"
              style={{ width: 12, height: 12 }}
            />
            WSL
          </label>
          {currentThread.use_wsl && (
            <select
              value={currentThread.wsl_distro ?? ''}
              onChange={(e) => setWsl(threadId, true, e.target.value || null)}
              disabled={currentThread.has_messages}
              className="text-xs bg-transparent border rounded px-1 py-0.5 outline-none cursor-pointer"
              style={{
                color: '#fbbf24',
                borderColor: 'rgba(251, 191, 36, 0.3)',
                background: 'var(--color-surface)',
                opacity: currentThread.has_messages ? 0.4 : 1,
              }}
            >
              {availableDistros.map((d) => (
                <option key={d} value={d} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
                  {d}
                </option>
              ))}
            </select>
          )}
        </span>
      )}

      <span className="flex items-center gap-1 flex-shrink-0 mb-2">
        <CliHealthIndicator threadId={threadId} />
        <select
          value={currentThread?.provider ?? 'claude-code'}
          onChange={(e) => {
            const provider = e.target.value as Provider
            const defaultModel = getDefaultModelForProvider(provider)
            if (provider === 'codex' && currentThread && isLocalLocation && !currentThread.use_wsl) {
              const distro = currentThread.wsl_distro ?? availableDistros[0] ?? null
              if (distro) setWsl(threadId, true, distro)
            }
            setProviderAndModel(threadId, provider, defaultModel)
          }}
          disabled={isProcessing}
          className="text-xs bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer"
          style={{
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface)',
            opacity: isProcessing ? 0.4 : 1,
          }}
          title="Select provider"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
              {p.label}
            </option>
          ))}
        </select>
      </span>
      {showCodexWslWarning && (
        <span className="text-xs flex-shrink-0 mb-2" style={{ color: '#facc15' }} title="Codex is significantly more reliable via WSL on Windows.">
          Codex + WSL recommended
        </span>
      )}
      <select
        value={currentThread?.model ?? getDefaultModelForProvider((currentThread?.provider ?? 'claude-code') as Provider)}
        onChange={(e) => setModel(threadId, e.target.value)}
        disabled={isProcessing}
        className="text-xs flex-shrink-0 bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer mb-2"
        style={{
          color: 'var(--color-text-muted)',
          borderColor: 'var(--color-border)',
          background: 'var(--color-surface)',
          opacity: isProcessing ? 0.4 : 1,
        }}
        title="Select model"
      >
        {getModelsForProvider((currentThread?.provider ?? 'claude-code') as Provider).map((m) => (
          <option key={m.id} value={m.id} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
            {m.label}
          </option>
        ))}
      </select>

      {isProcessing && (
        <>
          <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>|</span>
          <span className="mb-2 font-mono text-xs tabular-nums" style={{ color: 'var(--color-claude)' }}>
            {formatElapsed(elapsedSeconds)}
          </span>
        </>
      )}
    </div>
  )
}
