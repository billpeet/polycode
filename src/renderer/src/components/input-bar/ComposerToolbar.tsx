import { useEffect, useMemo, useState } from 'react'
import { Thread, PROVIDERS, Provider, ModelOption, ReasoningLevel, getDefaultModelForProvider, getModelsForProvider } from '../../types/ipc'
import CliHealthIndicator from './CliHealthIndicator'
import { PlanIcon, YoloIcon, FastIcon, formatElapsed } from './icons'

function mergeModelOptions(primary: readonly ModelOption[], fallback: readonly ModelOption[]): ModelOption[] {
  const seen = new Set<string>()
  return [...primary, ...fallback].filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

interface ComposerToolbarProps {
  threadId: string
  planMode: boolean
  setPlanMode: (threadId: string, value: boolean) => void
  fastMode: boolean
  setFastMode: (threadId: string, value: boolean) => void
  isProcessing: boolean
  isLocalLocation: boolean | undefined
  currentThread: Thread | undefined
  availableDistros: string[]
  setYolo: (threadId: string, yoloMode: boolean) => void
  setWsl: (threadId: string, useWsl: boolean, distro: string | null) => void
  setProviderAndModel: (threadId: string, provider: Provider, model: string) => void
  setModel: (threadId: string, model: string) => void
  setReasoningLevel: (threadId: string, reasoningLevel: ReasoningLevel) => void
  elapsedSeconds: number
}

export default function ComposerToolbar({
  threadId,
  planMode,
  setPlanMode,
  fastMode,
  setFastMode,
  isProcessing,
  isLocalLocation,
  currentThread,
  availableDistros,
  setYolo,
  setWsl,
  setProviderAndModel,
  setModel,
  setReasoningLevel,
  elapsedSeconds,
}: ComposerToolbarProps) {
  const supportsYolo = currentThread?.provider === 'claude-code' || currentThread?.provider === 'codex' || currentThread?.provider === 'cursor'
  // Fast mode (priority processing) is currently supported by Claude Code and Codex.
  const supportsFastMode = currentThread?.provider === 'claude-code' || currentThread?.provider === 'codex'
  const currentProvider = (currentThread?.provider ?? 'claude-code') as Provider
  const [liveClaudeModels, setLiveClaudeModels] = useState<ModelOption[]>([])
  const [liveCodexModels, setLiveCodexModels] = useState<ModelOption[]>([])
  const [liveOpenCodeModels, setLiveOpenCodeModels] = useState<ModelOption[]>([])
  const [livePiModels, setLivePiModels] = useState<ModelOption[]>([])
  const [liveCursorModels, setLiveCursorModels] = useState<ModelOption[]>([])

  useEffect(() => {
    if (currentProvider !== 'claude-code') return

    let cancelled = false
    setLiveClaudeModels([])
    window.api.invoke('models:claudeAvailable', threadId)
      .then((models) => {
        if (!cancelled && models.length > 0) setLiveClaudeModels(models)
      })
      .catch(() => {
        // Keep static fallback models when Claude Code is unavailable or unauthenticated.
      })

    return () => { cancelled = true }
  }, [currentProvider, threadId, currentThread?.use_wsl, currentThread?.wsl_distro])

  useEffect(() => {
    if (currentProvider !== 'codex') return

    let cancelled = false
    setLiveCodexModels([])
    window.api.invoke('models:codexAvailable', threadId)
      .then((models) => {
        if (!cancelled && models.length > 0) setLiveCodexModels(models)
      })
      .catch(() => {
        // Keep static fallback models when codex is unavailable or unauthenticated.
      })

    return () => { cancelled = true }
  }, [currentProvider, threadId, currentThread?.use_wsl, currentThread?.wsl_distro])

  useEffect(() => {
    if (currentProvider !== 'opencode') return

    let cancelled = false
    setLiveOpenCodeModels([])
    window.api.invoke('models:opencodeAvailable', threadId)
      .then((models) => {
        if (!cancelled && models.length > 0) setLiveOpenCodeModels(models)
      })
      .catch(() => {
        // Keep static fallback models when opencode is unavailable or unauthenticated.
      })

    return () => { cancelled = true }
  }, [currentProvider, threadId, currentThread?.use_wsl, currentThread?.wsl_distro])

  useEffect(() => {
    if (currentProvider !== 'pi') return

    let cancelled = false
    setLivePiModels([])
    window.api.invoke('models:piAvailable', threadId)
      .then((models) => {
        if (!cancelled && models.length > 0) setLivePiModels(models)
      })
      .catch(() => {
        // Keep static fallback models when pi is unavailable or unauthenticated.
      })

    return () => { cancelled = true }
  }, [currentProvider, threadId, currentThread?.use_wsl, currentThread?.wsl_distro])

  useEffect(() => {
    if (currentProvider !== 'cursor') return

    let cancelled = false
    setLiveCursorModels([])
    window.api.invoke('models:cursorAvailable', threadId)
      .then((models) => {
        if (!cancelled && models.length > 0) setLiveCursorModels(models)
      })
      .catch(() => {
        // Keep static fallback models when Cursor is unavailable or unauthenticated.
      })

    return () => { cancelled = true }
  }, [currentProvider, threadId, currentThread?.use_wsl, currentThread?.wsl_distro])

  const modelOptions = useMemo(() => {
    const staticModels = getModelsForProvider(currentProvider)
    const baseModels = currentProvider === 'claude-code' && liveClaudeModels.length > 0
      ? mergeModelOptions(staticModels, liveClaudeModels)
      : currentProvider === 'codex' && liveCodexModels.length > 0
        ? liveCodexModels
        : currentProvider === 'opencode' && liveOpenCodeModels.length > 0
          ? liveOpenCodeModels
          : currentProvider === 'pi' && livePiModels.length > 0
            ? livePiModels
            : currentProvider === 'cursor' && liveCursorModels.length > 0
              ? liveCursorModels
              : staticModels
    const currentModel = currentThread?.model
    if (!currentModel || baseModels.some((model) => model.id === currentModel)) return baseModels
    return [{ id: currentModel, label: currentModel }, ...baseModels]
  }, [currentProvider, currentThread?.model, liveClaudeModels, liveCodexModels, liveOpenCodeModels, livePiModels, liveCursorModels])

  const selectedModel = useMemo(
    () => modelOptions.find((model) => model.id === currentThread?.model),
    [modelOptions, currentThread?.model]
  )
  const getReasoningLevels = (model?: ModelOption): ReasoningLevel[] => {
    if (model?.reasoningLevels?.length) return model.reasoningLevels
    if (model?.reasoning) return ['off', 'minimal', 'low', 'medium', 'high']
    return ['off']
  }
  const reasoningOptions = getReasoningLevels(selectedModel)
  const currentReasoningLevel = reasoningOptions.includes(currentThread?.reasoning_level ?? 'off')
    ? currentThread?.reasoning_level ?? 'off'
    : reasoningOptions[0]
  const showReasoningSelector = currentProvider === 'pi' || currentProvider === 'codex' || currentProvider === 'claude-code' || currentProvider === 'opencode' || currentProvider === 'cursor'

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
      {supportsFastMode && (
        <>
          <button
            onClick={() => setFastMode(threadId, !fastMode)}
            disabled={isProcessing}
            title={fastMode
              ? 'Fast mode: ON - priority processing for faster responses (uses session limits faster)'
              : 'Fast mode: OFF - standard processing speed'}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-30 mb-2"
            style={{
              background: fastMode ? 'rgba(255, 106, 0, 0.15)' : 'transparent',
              color: fastMode ? '#ff6a00' : 'var(--color-text-muted)',
              border: `1px solid ${fastMode ? 'rgba(255, 106, 0, 0.3)' : 'transparent'}`,
            }}
          >
            <FastIcon />
            Fast
          </button>
          <span className="mb-2 text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }}>|</span>
        </>
      )}
      {supportsYolo && currentThread && (
        <>
          <button
            onClick={() => setYolo(threadId, !currentThread.yolo_mode)}
            disabled={isProcessing}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-60 mb-2"
            title={currentThread.provider === 'codex'
              ? 'Codex Yolo: bypass approvals and sandbox'
              : 'Yolo: bypass provider approval checks where supported'}
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
            const staticDefault = getDefaultModelForProvider(provider)
            const liveModels = provider === 'claude-code' ? liveClaudeModels : provider === 'codex' ? liveCodexModels : provider === 'opencode' ? liveOpenCodeModels : provider === 'pi' ? livePiModels : provider === 'cursor' ? liveCursorModels : []
            const defaultModel = liveModels.length > 0
              ? (liveModels.some((model) => model.id === staticDefault) ? staticDefault : liveModels[0].id)
              : staticDefault
            setProviderAndModel(threadId, provider, defaultModel)
            const defaultReasoningLevels = getReasoningLevels(liveModels.find((model) => model.id === defaultModel) ?? getModelsForProvider(provider).find((model) => model.id === defaultModel))
            if (!defaultReasoningLevels.includes(currentThread?.reasoning_level ?? 'off')) setReasoningLevel(threadId, defaultReasoningLevels[0])
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
      <select
        value={currentThread?.model ?? getDefaultModelForProvider(currentProvider)}
        onChange={(e) => {
          const nextModel = e.target.value
          setModel(threadId, nextModel)
          const levels = getReasoningLevels(modelOptions.find((m) => m.id === nextModel))
          if (!levels.includes(currentThread?.reasoning_level ?? 'off')) setReasoningLevel(threadId, levels[0])
        }}
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
        {modelOptions.map((m) => (
          <option key={m.id} value={m.id} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
            {m.label}
          </option>
        ))}
      </select>

      {showReasoningSelector && (
        <select
          value={currentReasoningLevel}
          onChange={(e) => setReasoningLevel(threadId, e.target.value as ReasoningLevel)}
          disabled={isProcessing || reasoningOptions.length <= 1}
          className="text-xs flex-shrink-0 bg-transparent border rounded px-1.5 py-0.5 outline-none cursor-pointer mb-2"
          style={{
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border)',
            background: 'var(--color-surface)',
            opacity: isProcessing || reasoningOptions.length <= 1 ? 0.4 : 1,
          }}
          title={`Select ${currentProvider === 'claude-code' ? 'Claude effort' : currentProvider === 'codex' ? 'Codex reasoning' : currentProvider === 'opencode' ? 'OpenCode reasoning' : 'Pi reasoning'} level`}
        >
          {reasoningOptions.map((level) => (
            <option key={level} value={level} style={{ background: 'var(--color-surface)', color: 'var(--color-text)' }}>
              {level === 'off' ? (currentProvider === 'claude-code' ? 'Effort default' : currentProvider === 'opencode' ? 'Reasoning default' : 'Reasoning off') : `${currentProvider === 'claude-code' ? 'Effort' : 'Reasoning'} ${level}`}
            </option>
          ))}
        </select>
      )}

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
