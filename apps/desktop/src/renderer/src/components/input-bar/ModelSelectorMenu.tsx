import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CodexPersonality,
  CodexReasoningSummary,
  ModelOption,
  PROVIDERS,
  Provider,
  ReasoningLevel,
  Thread,
  getModelsForProvider,
} from '../../types/ipc'
import { useFavouritesStore, formatFavourite, FAVOURITE_SLOTS, Favourite } from '../../stores/favourites'
import { useToastStore } from '../../stores/toast'
import { ProviderIcon } from './ProviderIcon'

interface ModelSelectorMenuProps {
  isProcessing: boolean
  /** Once a thread has messages, its history lives with one provider — models
   * can change, the provider cannot. */
  providerLocked: boolean
  currentThread: Thread | undefined
  /** Models for the *current* provider (live discovery merged with the registry). */
  modelOptions: readonly ModelOption[]
  modelsLoading?: boolean
  modelsError?: string | null
  onRetryModels?: () => void
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

/** The rail has one tab per provider plus the favourites tab. */
type Tab = 'favourites' | Provider

const FAVOURITES_TAB = 'favourites' as const
const HOVER_BG = 'rgba(255,255,255,0.06)'
const ACTIVE_BG = 'rgba(232, 123, 95, 0.14)'

const selectClassName = 'min-w-0 cursor-pointer rounded border bg-transparent px-1.5 py-0.5 text-[11px] outline-none disabled:cursor-default disabled:opacity-40'
const selectStyle: React.CSSProperties = {
  color: 'var(--color-text)',
  borderColor: 'var(--color-border)',
  background: 'var(--color-surface-2)',
}
const optionStyle: React.CSSProperties = { background: 'var(--color-surface)', color: 'var(--color-text)' }

function providerLabel(provider: Provider): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider
}

function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M ctx` : `${Math.round(tokens / 1000)}k ctx`
}

/** Short descriptor under a model's name: context size, reasoning range. */
function describeModel(model: ModelOption): string {
  const parts: string[] = []
  if (model.contextWindow) parts.push(formatContextWindow(model.contextWindow))
  else if (model.contextWindows?.length) parts.push(model.contextWindows.map((cw) => cw.label).join(' / ') + ' ctx')
  const levels = model.reasoningLevels?.filter((level) => level !== 'off')
  if (levels?.length) parts.push(`effort ${levels[0]}–${levels[levels.length - 1]}`)
  else if (model.reasoning) parts.push('reasoning')
  return parts.join(' · ')
}

function FineTuneField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="flex-shrink-0 text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)', opacity: 0.8 }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function StarIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="m12 3.5 2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.8l6.1-.7Z" />
    </svg>
  )
}

interface ModelRowProps {
  provider: Provider
  model: ModelOption
  selected: boolean
  disabled: boolean
  disabledReason?: string
  favouriteSlot: number | undefined
  showProvider: boolean
  onSelect: () => void
  onToggleFavourite: () => void
}

function ModelRow({ provider, model, selected, disabled, disabledReason, favouriteSlot, showProvider, onSelect, onToggleFavourite }: ModelRowProps) {
  const subtitle = describeModel(model)
  const favourited = favouriteSlot !== undefined
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={model.label}
      className="group flex items-center gap-2 rounded-md px-2 py-1.5"
      style={{ background: selected ? ACTIVE_BG : undefined }}
      onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = HOVER_BG }}
      onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = '' }}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        title={disabled ? disabledReason : model.id}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default disabled:opacity-40"
      >
        {showProvider && (
          <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            <ProviderIcon provider={provider} size={14} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium" style={{ color: selected ? 'var(--color-claude)' : 'var(--color-text)' }}>
              {model.label}
            </span>
            {favourited && (
              <span
                className="flex-shrink-0 rounded px-1 text-[9px] font-semibold leading-4"
                style={{ background: 'rgba(232, 123, 95, 0.18)', color: 'var(--color-claude)' }}
                title={`Favourite ${favouriteSlot} — Ctrl+${favouriteSlot}`}
              >
                Ctrl+{favouriteSlot}
              </span>
            )}
          </span>
          {(subtitle || showProvider) && (
            <span className="block truncate text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
              {showProvider ? [providerLabel(provider), subtitle].filter(Boolean).join(' · ') : subtitle}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleFavourite}
        aria-label={favourited ? `Remove ${model.label} from favourites` : `Add ${model.label} to favourites`}
        aria-pressed={favourited}
        title={favourited ? `Remove from favourites (slot ${favouriteSlot})` : 'Add to favourites'}
        className="flex-shrink-0 rounded p-1 transition-opacity"
        style={{
          color: favourited ? 'var(--color-claude)' : 'var(--color-text-muted)',
          opacity: favourited ? 1 : 0.45,
        }}
      >
        <StarIcon filled={favourited} />
      </button>
    </div>
  )
}

/**
 * Single toolbar button summarising the current provider/model/effort combo.
 * Opens a browser: search across every provider, an icon rail to switch
 * between the favourites list and each provider's catalogue, and a footer
 * with the fine-tuning controls (effort, Codex summary/personality, context)
 * for whatever is currently selected.
 */
export default function ModelSelectorMenu({
  isProcessing,
  providerLocked,
  currentThread,
  modelOptions,
  modelsLoading = false,
  modelsError = null,
  onRetryModels,
  reasoningOptions,
  currentReasoningLevel,
  showReasoningSelector,
  contextWindows,
  onSelectProvider: _onSelectProvider,
  onSelectModel,
  onSelectReasoning,
  onSelectCodexSummary,
  onSelectPersonality,
  onSelectContextWindow,
  applyFavourite,
}: ModelSelectorMenuProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const bySlot = useFavouritesStore((s) => s.bySlot)
  const saveFav = useFavouritesStore((s) => s.save)
  const clearFav = useFavouritesStore((s) => s.clear)
  const addToast = useToastStore((s) => s.add)

  const currentProvider = (currentThread?.provider ?? 'claude-code') as Provider
  const [tab, setTab] = useState<Tab>(currentProvider)

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

  const toggleOpen = (): void => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        setQuery('')
        setTab(currentProvider)
        requestAnimationFrame(() => searchRef.current?.focus())
      }
      return !wasOpen
    })
  }

  const current: Favourite | null = currentThread
    ? { provider: currentProvider, model: currentThread.model, reasoningLevel: currentThread.reasoning_level ?? 'off' }
    : null

  const modelsFor = (provider: Provider): readonly ModelOption[] =>
    provider === currentProvider ? modelOptions : getModelsForProvider(provider)
  /** The provider whose catalogue the pane is browsing, or null on the favourites tab. */
  const browsing: Provider | null = tab === FAVOURITES_TAB ? null : tab

  const needle = query.trim().toLowerCase()
  const searching = needle.length > 0

  /** Flat, provider-tagged list of what the right pane shows. */
  const visible = useMemo(() => {
    const rows: { provider: Provider; model: ModelOption }[] = []
    if (searching) {
      for (const { id } of PROVIDERS) {
        for (const model of modelsFor(id)) {
          if (
            model.label.toLowerCase().includes(needle) ||
            model.id.toLowerCase().includes(needle) ||
            providerLabel(id).toLowerCase().includes(needle)
          ) rows.push({ provider: id, model })
        }
      }
    } else if (browsing) {
      for (const model of modelsFor(browsing)) rows.push({ provider: browsing, model })
    }
    return rows
    // modelsFor closes over modelOptions/currentProvider, which are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, needle, browsing, modelOptions, currentProvider])

  const favouriteSlotFor = (provider: Provider, model: string): number | undefined => {
    const entry = Object.entries(bySlot).find(([, fav]) => fav.provider === provider && fav.model === model)
    return entry ? Number(entry[0]) : undefined
  }

  const crossProviderBlocked = (provider: Provider): boolean => providerLocked && provider !== currentProvider
  const lockedReason = 'Provider is locked once a thread has messages — other providers have no access to this conversation history'

  const choose = (provider: Provider, model: ModelOption): void => {
    if (isProcessing || crossProviderBlocked(provider)) return
    if (provider === currentProvider) onSelectModel(model.id)
    else applyFavourite({ provider, model: model.id, reasoningLevel: 'off' })
    setOpen(false)
  }

  const toggleFavourite = (provider: Provider, model: ModelOption): void => {
    const existing = favouriteSlotFor(provider, model.id)
    if (existing !== undefined) {
      clearFav(existing)
      return
    }
    const slot = FAVOURITE_SLOTS.find((s) => !bySlot[s])
    if (!slot) {
      addToast({ type: 'warning', message: 'All nine favourite slots are full — clear one first' })
      return
    }
    const reasoningLevel = current && current.provider === provider && current.model === model.id ? current.reasoningLevel : 'off'
    const fav: Favourite = { provider, model: model.id, reasoningLevel }
    saveFav(slot, fav)
    addToast({ type: 'success', message: `Saved favourite ${slot}: ${formatFavourite(fav)}` })
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((index) => Math.min(index + 1, Math.max(0, visible.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && visible[highlighted]) {
      event.preventDefault()
      choose(visible[highlighted].provider, visible[highlighted].model)
    }
  }

  const modelLabel = modelOptions.find((m) => m.id === currentThread?.model)?.label ?? currentThread?.model ?? ''
  const summaryParts = [modelLabel]
  if (showReasoningSelector && currentReasoningLevel !== 'off') summaryParts.push(currentReasoningLevel)
  const summary = summaryParts.filter(Boolean).join(' · ')

  const effortLabel = currentProvider === 'claude-code' || currentProvider === 'cursor' || currentProvider === 'opencode' ? 'Effort' : 'Reasoning'
  const paneTitle = searching
    ? `Results for “${query.trim()}”`
    : browsing ? providerLabel(browsing) : 'Favourites'

  const railTabs: { id: Tab; label: string }[] = [
    { id: FAVOURITES_TAB, label: 'Favourites' },
    ...PROVIDERS.map((p) => ({ id: p.id as Tab, label: p.label })),
  ]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Model settings — provider, model, effort and favourites (Ctrl+1…9 to load, Ctrl+Shift+1…9 to save)"
        className="flex max-w-[280px] items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-all duration-150"
        style={{
          color: 'var(--color-text-muted)',
          border: `1px solid ${open ? 'rgba(232, 123, 95, 0.45)' : 'var(--color-border)'}`,
          background: 'var(--color-surface)',
        }}
      >
        <span className="flex items-center" style={{ color: open ? 'var(--color-claude)' : undefined }}>
          <ProviderIcon provider={currentProvider} size={12} />
        </span>
        {/* In a narrow composer the logo alone identifies the provider. */}
        <span className="truncate @max-[480px]:hidden">{providerLabel(currentProvider)} · </span>
        <span className="truncate">{summary}</span>
        <span style={{ opacity: 0.6, fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Model browser"
          className="absolute right-0 z-50 flex flex-col overflow-hidden rounded-lg text-xs shadow-2xl"
          style={{
            width: 480,
            height: 420,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            bottom: '100%',
            marginBottom: 6,
            boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
          }}
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ color: 'var(--color-text-muted)' }}>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={searchRef}
              role="combobox"
              aria-label="Search models"
              aria-expanded="true"
              aria-controls="model-browser-options"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setHighlighted(0) }}
              onKeyDown={onSearchKeyDown}
              spellCheck={false}
              autoComplete="off"
              placeholder="Search models across every provider…"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--color-text)' }}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} className="rounded px-1" style={{ color: 'var(--color-text-muted)' }} title="Clear search">✕</button>
            )}
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Rail */}
            <nav
              aria-label="Providers"
              className="flex w-11 flex-shrink-0 flex-col items-center gap-1 py-2"
              style={{ borderRight: '1px solid var(--color-border)', background: 'var(--color-bg)' }}
            >
              {railTabs.map(({ id, label }) => {
                const active = !searching && tab === id
                const isCurrent = id === currentProvider
                const dimmed = id !== FAVOURITES_TAB && crossProviderBlocked(id)
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={label}
                    title={id === FAVOURITES_TAB ? 'Favourites (Ctrl+1…9)' : isCurrent ? `${label} — current provider` : label}
                    onClick={() => { setQuery(''); setTab(id); setHighlighted(0) }}
                    className="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors"
                    style={{
                      color: active ? 'var(--color-claude)' : 'var(--color-text-muted)',
                      background: active ? ACTIVE_BG : 'transparent',
                      opacity: dimmed ? 0.4 : 1,
                    }}
                  >
                    {id === FAVOURITES_TAB ? <StarIcon filled={active} size={15} /> : <ProviderIcon provider={id} size={16} />}
                    {isCurrent && (
                      <span
                        className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full"
                        style={{ background: 'var(--color-claude)' }}
                        aria-hidden
                      />
                    )}
                  </button>
                )
              })}
            </nav>

            {/* Pane */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
                <span className="truncate text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)', opacity: 0.8 }}>
                  {paneTitle}
                </span>
                {!searching && tab === currentProvider && (
                  <span className="flex items-center gap-1.5">
                    {modelsLoading && (
                      <span className="status-spinner h-3 w-3 flex-shrink-0" title="Loading models" aria-label="Loading models" />
                    )}
                    {!modelsLoading && onRetryModels && (
                      <button
                        type="button"
                        onClick={onRetryModels}
                        className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                        style={{ color: modelsError ? 'var(--color-claude)' : 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}
                        title={modelsError ?? 'Refresh models from Pi'}
                      >
                        {modelsError ? 'Retry' : 'Refresh'}
                      </button>
                    )}
                  </span>
                )}
              </div>

              <div id="model-browser-options" role="listbox" aria-label={paneTitle} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
                {!searching && tab === FAVOURITES_TAB ? (
                  <FavouritesList
                    bySlot={bySlot}
                    current={current}
                    isProcessing={isProcessing}
                    blocked={crossProviderBlocked}
                    lockedReason={lockedReason}
                    onLoad={(fav) => { applyFavourite(fav); setOpen(false) }}
                    onSet={(slot) => {
                      if (!current) return
                      saveFav(slot, current)
                      addToast({ type: 'success', message: `Saved favourite ${slot}: ${formatFavourite(current)}` })
                    }}
                    onClear={clearFav}
                  />
                ) : visible.length === 0 ? (
                  <div className="px-2 py-6 text-center" style={{ color: 'var(--color-text-muted)' }}>
                    {searching ? 'No matching models' : 'No models available'}
                  </div>
                ) : (
                  visible.map(({ provider, model }, index) => {
                    const blocked = crossProviderBlocked(provider)
                    return (
                      <div key={`${provider}:${model.id}`} style={{ outline: searching && index === highlighted ? `1px solid rgba(232,123,95,0.35)` : undefined, borderRadius: 6 }}>
                        <ModelRow
                          provider={provider}
                          model={model}
                          selected={provider === currentProvider && model.id === currentThread?.model}
                          disabled={isProcessing || blocked}
                          disabledReason={blocked ? lockedReason : undefined}
                          favouriteSlot={favouriteSlotFor(provider, model.id)}
                          showProvider={searching}
                          onSelect={() => choose(provider, model)}
                          onToggleFavourite={() => toggleFavourite(provider, model)}
                        />
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>

          {/* Fine-tune footer for the current selection */}
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-bg)' }}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              <ProviderIcon provider={currentProvider} size={12} />
              <span className="truncate" style={{ color: 'var(--color-text)' }}>{modelLabel}</span>
            </span>
            <span className="flex-1" />
            {showReasoningSelector && (
              <FineTuneField label={effortLabel}>
                <select
                  value={currentReasoningLevel}
                  onChange={(e) => onSelectReasoning(e.target.value as ReasoningLevel)}
                  disabled={isProcessing || reasoningOptions.length <= 1}
                  className={selectClassName}
                  style={selectStyle}
                  title={`Select ${effortLabel.toLowerCase()} level`}
                >
                  {reasoningOptions.map((level) => (
                    <option key={level} value={level} style={optionStyle}>
                      {level === 'off'
                        ? (currentProvider === 'claude-code' || currentProvider === 'opencode' || currentProvider === 'cursor' ? 'Default' : 'Off')
                        : level}
                    </option>
                  ))}
                </select>
              </FineTuneField>
            )}
            {currentProvider === 'codex' && (
              <FineTuneField label="Summary">
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
              </FineTuneField>
            )}
            {currentProvider === 'codex' && (
              <FineTuneField label="Personality">
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
              </FineTuneField>
            )}
            {contextWindows.length > 0 && (
              <FineTuneField label="Context">
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
              </FineTuneField>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface FavouritesListProps {
  bySlot: Record<number, Favourite>
  current: Favourite | null
  isProcessing: boolean
  blocked: (provider: Provider) => boolean
  lockedReason: string
  onLoad: (fav: Favourite) => void
  onSet: (slot: number) => void
  onClear: (slot: number) => void
}

function FavouritesList({ bySlot, current, isProcessing, blocked, lockedReason, onLoad, onSet, onClear }: FavouritesListProps) {
  return (
    <div className="flex flex-col gap-0.5">
      {FAVOURITE_SLOTS.map((slot) => {
        const fav = bySlot[slot]
        const crossProvider = !!fav && blocked(fav.provider)
        const isCurrent = !!fav && !!current && fav.provider === current.provider && fav.model === current.model && fav.reasoningLevel === current.reasoningLevel
        return (
          <div
            key={slot}
            className="flex items-center gap-2 rounded-md px-2 py-1.5"
            style={{ background: isCurrent ? ACTIVE_BG : undefined }}
            onMouseEnter={(event) => { if (!isCurrent) event.currentTarget.style.background = HOVER_BG }}
            onMouseLeave={(event) => { if (!isCurrent) event.currentTarget.style.background = '' }}
          >
            <kbd
              className="flex h-5 flex-shrink-0 items-center justify-center rounded px-1.5 text-[10px] font-semibold"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
              title={`Ctrl+${slot} loads · Ctrl+Shift+${slot} saves`}
            >
              Ctrl+{slot}
            </kbd>
            <button
              type="button"
              onClick={() => { if (fav && !crossProvider) onLoad(fav) }}
              disabled={!fav || isProcessing || crossProvider}
              className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default disabled:opacity-40"
              title={!fav ? 'Empty slot' : crossProvider ? `${formatFavourite(fav)} — ${lockedReason}` : `Load: ${formatFavourite(fav)}`}
            >
              {fav ? (
                <>
                  <span className="flex-shrink-0" style={{ color: isCurrent ? 'var(--color-claude)' : 'var(--color-text-muted)' }}>
                    <ProviderIcon provider={fav.provider} size={14} />
                  </span>
                  <span className="truncate text-[12px]" style={{ color: isCurrent ? 'var(--color-claude)' : 'var(--color-text)' }}>
                    {formatFavourite(fav)}
                  </span>
                </>
              ) : (
                <span className="text-[12px] italic" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>Empty</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onSet(slot)}
              disabled={!current}
              className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
              style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}
              title="Save current combo to this slot"
            >
              Set
            </button>
            <button
              type="button"
              onClick={() => onClear(slot)}
              disabled={!fav}
              aria-label={`Clear favourite ${slot}`}
              className="flex-shrink-0 rounded px-1 disabled:opacity-30"
              style={{ color: 'var(--color-text-muted)' }}
              title="Clear this slot"
            >
              ✕
            </button>
          </div>
        )
      })}
      <p className="px-2 pt-2 text-[10px]" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
        Star a model in any provider tab to fill the next free slot. Ctrl+1…9 loads a slot; Ctrl+Shift+1…9 saves the current combo to it.
      </p>
    </div>
  )
}
