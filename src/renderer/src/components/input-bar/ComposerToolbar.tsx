import { useEffect, useMemo, useRef, useState } from 'react'
import { Thread, PROVIDERS, Provider, PermissionMode, ModelOption, ReasoningLevel, getDefaultModelForProvider, getModelsForProvider } from '../../types/ipc'
import CliHealthIndicator from './CliHealthIndicator'
import { PlanIcon, YoloIcon, FastIcon, formatElapsed } from './icons'
import { useFavouritesStore, formatFavourite, FAVOURITE_SLOTS, Favourite } from '../../stores/favourites'
import { useToastStore } from '../../stores/toast'

function FavouritesMenu({
  currentThread,
  applyFavourite,
}: {
  currentThread: Thread | undefined
  applyFavourite: (fav: Favourite) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const bySlot = useFavouritesStore((s) => s.bySlot)
  const saveFav = useFavouritesStore((s) => s.save)
  const clearFav = useFavouritesStore((s) => s.clear)
  const addToast = useToastStore((s) => s.add)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const current: Favourite | null = currentThread
    ? { provider: currentThread.provider as Provider, model: currentThread.model, reasoningLevel: currentThread.reasoning_level ?? 'off' }
    : null

  return (
    <div ref={ref} className="relative mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Favourite provider/model/effort combos (Ctrl+1…9 to load, Ctrl+Shift+1…9 to save)"
        className="flex items-center rounded-md px-1.5 py-0.5 text-xs transition-all duration-150"
        style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
      >
        ★
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 mt-1 w-72 rounded-md p-1 text-xs shadow-lg"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', bottom: '100%', marginBottom: 4 }}
        >
          {FAVOURITE_SLOTS.map((slot) => {
            const fav = bySlot[slot]
            return (
              <div key={slot} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[rgba(255,255,255,0.05)]">
                <span className="w-4 text-center" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>{slot}</span>
                <button
                  onClick={() => { if (fav) { applyFavourite(fav); setOpen(false) } }}
                  disabled={!fav}
                  className="flex-1 truncate text-left disabled:opacity-40"
                  style={{ color: fav ? 'var(--color-text)' : 'var(--color-text-muted)' }}
                  title={fav ? `Load: ${formatFavourite(fav)}` : 'Empty slot'}
                >
                  {fav ? formatFavourite(fav) : 'Empty'}
                </button>
                <button
                  onClick={() => {
                    if (!current) return
                    saveFav(slot, current)
                    addToast({ type: 'success', message: `Saved favourite ${slot}: ${formatFavourite(current)}` })
                  }}
                  disabled={!current}
                  className="rounded px-1 disabled:opacity-40"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Save current combo to this slot"
                >
                  Set
                </button>
                <button
                  onClick={() => clearFav(slot)}
                  disabled={!fav}
                  className="rounded px-1 disabled:opacity-30"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Clear this slot"
                >
                  ✕
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

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
  setPermissionMode: (threadId: string, permissionMode: PermissionMode) => void
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
  setPermissionMode,
  setWsl,
  setProviderAndModel,
  setModel,
  setReasoningLevel,
  elapsedSeconds,
}: ComposerToolbarProps) {
  const permissionOptions = useMemo<Array<{ mode: PermissionMode; label: string; title: string }>>(() => {
    if (currentThread?.provider === 'codex') {
      return [
        { mode: 'ask', label: 'Ask', title: 'Review writes and privileged actions before Codex runs them' },
        { mode: 'workspace', label: 'Workspace', title: 'Allow Codex to edit files in the workspace without asking' },
        { mode: 'yolo', label: 'Yolo', title: 'Bypass Codex approvals and sandbox' },
      ]
    }
    if (currentThread?.provider === 'claude-code' || currentThread?.provider === 'cursor') {
      return [
        { mode: 'ask', label: 'Ask', title: 'Ask before privileged provider actions' },
        { mode: 'yolo', label: 'Yolo', title: 'Bypass provider approval checks where supported' },
      ]
    }
    return []
  }, [currentThread?.provider])
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
      ? mergeModelOptions(liveClaudeModels, staticModels)
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
      {permissionOptions.length > 0 && currentThread && (
        <>
          <div
            className="flex items-center overflow-hidden rounded-md mb-2"
            style={{ border: '1px solid var(--color-border)' }}
          >
            <span className="flex h-full items-center px-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <YoloIcon />
            </span>
            {permissionOptions.map((option) => {
              const selected = currentThread.permission_mode === option.mode || (!currentThread.permission_mode && option.mode === (currentThread.yolo_mode ? 'yolo' : 'ask'))
              return (
                <button
                  key={option.mode}
                  onClick={() => setPermissionMode(threadId, option.mode)}
                  disabled={isProcessing || selected}
                  className="px-2 py-1 text-xs font-medium transition-all duration-150 disabled:opacity-80"
                  title={option.title}
                  style={{
                    background: selected
                      ? option.mode === 'yolo'
                        ? 'rgba(249, 115, 22, 0.15)'
                        : option.mode === 'workspace'
                          ? 'rgba(59, 130, 246, 0.14)'
                          : 'rgba(34, 197, 94, 0.12)'
                      : 'transparent',
                    color: selected
                      ? option.mode === 'yolo'
                        ? '#f97316'
                        : option.mode === 'workspace'
                          ? '#60a5fa'
                          : '#22c55e'
                      : 'var(--color-text-muted)',
                    borderLeft: '1px solid var(--color-border)',
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
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

      <FavouritesMenu
        currentThread={currentThread}
        applyFavourite={(fav) => {
          setProviderAndModel(threadId, fav.provider, fav.model)
          setReasoningLevel(threadId, fav.reasoningLevel)
        }}
      />

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
