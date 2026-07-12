import { useEffect, useRef, useState } from 'react'
import { CodexPersonality, CodexReasoningSummary, ModelOption, PROVIDERS, Provider, ReasoningLevel, Thread } from '../../types/ipc'
import { useFavouritesStore, formatFavourite, FAVOURITE_SLOTS, Favourite } from '../../stores/favourites'
import { useToastStore } from '../../stores/toast'

interface ModelSelectorMenuProps {
  isProcessing: boolean
  currentThread: Thread | undefined
  modelOptions: readonly ModelOption[]
  reasoningOptions: readonly ReasoningLevel[]
  currentReasoningLevel: ReasoningLevel
  showReasoningSelector: boolean
  contextWindows: { value: string; label: string }[]
  onSelectProvider: (provider: Provider) => void
  onSelectModel: (model: string) => void
  onSelectReasoning: (level: ReasoningLevel) => void
  onSelectCodexSummary: (summary: CodexReasoningSummary) => void
  onSelectPersonality: (personality: CodexPersonality) => void
  onSelectContextWindow: (context: string | null) => void
  applyFavourite: (fav: Favourite) => void
}

const selectClassName = 'flex-1 min-w-0 cursor-pointer rounded border bg-transparent px-1.5 py-0.5 text-xs outline-none disabled:cursor-default disabled:opacity-40'
const selectStyle: React.CSSProperties = {
  color: 'var(--color-text)',
  borderColor: 'var(--color-border)',
  background: 'var(--color-surface)',
}
const optionStyle: React.CSSProperties = { background: 'var(--color-surface)', color: 'var(--color-text)' }

function SelectRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="w-20 flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </span>
      {children}
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
      {children}
    </div>
  )
}

/**
 * Single toolbar button summarising the current provider/model/effort combo.
 * Opens a popup with the favourite slots plus every fine-tuning control
 * (provider, model, effort/reasoning, Codex summary/personality, context window).
 */
export default function ModelSelectorMenu({
  isProcessing,
  currentThread,
  modelOptions,
  reasoningOptions,
  currentReasoningLevel,
  showReasoningSelector,
  contextWindows,
  onSelectProvider,
  onSelectModel,
  onSelectReasoning,
  onSelectCodexSummary,
  onSelectPersonality,
  onSelectContextWindow,
  applyFavourite,
}: ModelSelectorMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const bySlot = useFavouritesStore((s) => s.bySlot)
  const saveFav = useFavouritesStore((s) => s.save)
  const clearFav = useFavouritesStore((s) => s.clear)
  const addToast = useToastStore((s) => s.add)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const currentProvider = (currentThread?.provider ?? 'claude-code') as Provider
  const current: Favourite | null = currentThread
    ? { provider: currentProvider, model: currentThread.model, reasoningLevel: currentThread.reasoning_level ?? 'off' }
    : null

  const providerLabel = PROVIDERS.find((p) => p.id === currentProvider)?.label ?? currentProvider
  const modelLabel = modelOptions.find((m) => m.id === currentThread?.model)?.label ?? currentThread?.model ?? ''
  const summaryParts = [providerLabel, modelLabel]
  if (showReasoningSelector && currentReasoningLevel !== 'off') summaryParts.push(currentReasoningLevel)
  const summary = summaryParts.filter(Boolean).join(' · ')

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Model settings — provider, model, effort and favourites (Ctrl+1…9 to load, Ctrl+Shift+1…9 to save)"
        className="flex max-w-[280px] items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-all duration-150"
        style={{
          color: 'var(--color-text-muted)',
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}
      >
        <span style={{ color: open ? 'var(--color-claude)' : undefined }}>★</span>
        <span className="truncate">{summary}</span>
        <span style={{ opacity: 0.6, fontSize: 9 }}>▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 z-50 w-80 rounded-md p-1 text-xs shadow-lg"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', bottom: '100%', marginBottom: 4 }}
        >
          <SectionHeader>Favourites</SectionHeader>
          {FAVOURITE_SLOTS.map((slot) => {
            const fav = bySlot[slot]
            return (
              <div key={slot} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-[rgba(255,255,255,0.05)]">
                <span className="w-4 text-center" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>{slot}</span>
                <button
                  onClick={() => { if (fav) { applyFavourite(fav); setOpen(false) } }}
                  disabled={!fav || isProcessing}
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

          <div className="my-1" style={{ borderTop: '1px solid var(--color-border)' }} />
          <SectionHeader>Fine-tune</SectionHeader>

          <SelectRow label="Provider">
            <select
              value={currentProvider}
              onChange={(e) => onSelectProvider(e.target.value as Provider)}
              disabled={isProcessing}
              className={selectClassName}
              style={selectStyle}
              title="Select provider"
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id} style={optionStyle}>{p.label}</option>
              ))}
            </select>
          </SelectRow>

          <SelectRow label="Model">
            <select
              value={currentThread?.model ?? ''}
              onChange={(e) => onSelectModel(e.target.value)}
              disabled={isProcessing}
              className={selectClassName}
              style={selectStyle}
              title="Select model"
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id} style={optionStyle}>{m.label}</option>
              ))}
            </select>
          </SelectRow>

          {showReasoningSelector && (
            <SelectRow label={currentProvider === 'claude-code' || currentProvider === 'cursor' || currentProvider === 'opencode' ? 'Effort' : 'Reasoning'}>
              <select
                value={currentReasoningLevel}
                onChange={(e) => onSelectReasoning(e.target.value as ReasoningLevel)}
                disabled={isProcessing || reasoningOptions.length <= 1}
                className={selectClassName}
                style={selectStyle}
                title={`Select ${currentProvider === 'claude-code' ? 'Claude effort' : currentProvider === 'codex' ? 'Codex reasoning' : currentProvider === 'opencode' ? 'OpenCode reasoning' : currentProvider === 'cursor' ? 'Cursor effort' : 'Pi reasoning'} level`}
              >
                {reasoningOptions.map((level) => (
                  <option key={level} value={level} style={optionStyle}>
                    {level === 'off'
                      ? (currentProvider === 'claude-code' || currentProvider === 'opencode' || currentProvider === 'cursor' ? 'Default' : 'Off')
                      : level}
                  </option>
                ))}
              </select>
            </SelectRow>
          )}

          {currentProvider === 'codex' && (
            <SelectRow label="Summary">
              <select
                value={currentThread?.codex_reasoning_summary ?? 'auto'}
                onChange={(e) => onSelectCodexSummary(e.target.value as CodexReasoningSummary)}
                disabled={isProcessing}
                className={selectClassName}
                style={selectStyle}
                title="Select Codex reasoning summary detail"
              >
                <option value="auto" style={optionStyle}>Auto</option>
                <option value="concise" style={optionStyle}>Concise</option>
                <option value="detailed" style={optionStyle}>Detailed</option>
                <option value="none" style={optionStyle}>Off</option>
              </select>
            </SelectRow>
          )}

          {currentProvider === 'codex' && (
            <SelectRow label="Personality">
              <select
                value={currentThread?.codex_personality ?? 'none'}
                onChange={(e) => onSelectPersonality(e.target.value as CodexPersonality)}
                disabled={isProcessing}
                className={selectClassName}
                style={selectStyle}
                title="Select Codex personality"
              >
                <option value="none" style={optionStyle}>None</option>
                <option value="friendly" style={optionStyle}>Friendly</option>
                <option value="pragmatic" style={optionStyle}>Pragmatic</option>
              </select>
            </SelectRow>
          )}

          {contextWindows.length > 0 && (
            <SelectRow label="Context">
              <select
                value={currentThread?.cursor_context ?? ''}
                onChange={(e) => onSelectContextWindow(e.target.value ? e.target.value : null)}
                disabled={isProcessing}
                className={selectClassName}
                style={selectStyle}
                title="Select context window"
              >
                <option value="" style={optionStyle}>Default</option>
                {contextWindows.map((cw) => (
                  <option key={cw.value} value={cw.value} style={optionStyle}>{cw.label}</option>
                ))}
              </select>
            </SelectRow>
          )}
        </div>
      )}
    </div>
  )
}
