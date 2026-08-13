import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  ModelOption,
  PROVIDERS,
  Provider,
  PermissionMode,
  RepoLocation,
  Routine,
  RoutineDraft,
  RoutineTriggerType,
  getDefaultModelForProvider,
  getModelsForProvider,
} from '../types/ipc'
import { useBackdropClose } from '../hooks/useBackdropClose'

interface Props {
  projectId: string
  /** null = create a new routine */
  routine: Routine | null
  onClose: () => void
  onSaved: () => void
}

type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom'

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Compile a UI preset to the cron string stored on the routine. */
function presetToCron(preset: SchedulePreset, time: string, weekday: number, custom: string): string {
  const [hh, mm] = time.split(':').map(Number)
  switch (preset) {
    case 'daily': return `${mm} ${hh} * * *`
    case 'weekdays': return `${mm} ${hh} * * 1-5`
    case 'weekly': return `${mm} ${hh} * * ${weekday}`
    case 'hourly': return `${mm} * * * *`
    case 'custom': return custom
  }
}

function inputLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function RoutineEditModal({ projectId, routine, onClose, onSaved }: Props) {
  const backdropClose = useBackdropClose(onClose)
  const [locations, setLocations] = useState<RepoLocation[]>([])

  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [locationId, setLocationId] = useState(routine?.location_id ?? '')
  const [provider, setProvider] = useState<Provider>((routine?.provider ?? 'claude-code') as Provider)
  const [model, setModel] = useState(routine?.model ?? getDefaultModelForProvider('claude-code'))
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(routine?.permission_mode ?? 'yolo')
  const [triggerType, setTriggerType] = useState<RoutineTriggerType>(routine?.trigger_type ?? 'cron')
  const [preset, setPreset] = useState<SchedulePreset>(routine?.trigger_type === 'cron' && routine.schedule ? 'custom' : 'daily')
  const [time, setTime] = useState('08:00')
  const [weekday, setWeekday] = useState(1)
  const [customCron, setCustomCron] = useState(routine?.trigger_type === 'cron' ? routine.schedule ?? '' : '')
  const [onceAt, setOnceAt] = useState(
    routine?.trigger_type === 'once' && routine.schedule
      ? inputLocalDateTime(new Date(routine.schedule))
      : inputLocalDateTime(new Date(Date.now() + 60 * 60 * 1000))
  )
  const [enabled, setEnabled] = useState(routine?.enabled ?? true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.invoke('locations:list', projectId).then((list) => {
      // Runs need a parent checkout to grow worktrees from — local, non-worktree only.
      const eligible = list.filter((l) => l.connection_type === 'local' && !l.is_worktree)
      setLocations(eligible)
      setLocationId((current) => current || (eligible[0]?.id ?? ''))
    })
  }, [projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Live model discovery, same as the composer toolbar: ask the provider CLI
  // for its current catalog and fall back to the static list when it is
  // unavailable or unauthenticated. `null` threadId = default (local) probing.
  const [liveModels, setLiveModels] = useState<ModelOption[]>([])
  useEffect(() => {
    setLiveModels([])
    const channel = (
      {
        'claude-code': 'models:claudeAvailable',
        codex: 'models:codexAvailable',
        opencode: 'models:opencodeAvailable',
        pi: 'models:piAvailable',
        cursor: 'models:cursorAvailable',
      } as const
    )[provider]
    if (!channel) return
    let cancelled = false
    window.api.invoke(channel, null)
      .then((discovered) => {
        if (cancelled || discovered.length === 0) return
        setLiveModels(discovered)
        // New routines snap their default onto the live catalog; an edited
        // routine keeps its saved model even if the catalog moved on.
        if (!routine) {
          setModel((current) => (discovered.some((m) => m.id === current) ? current : discovered[0].id))
        }
      })
      .catch(() => {
        // Keep static fallback models when the provider CLI is unavailable.
      })
    return () => { cancelled = true }
  }, [provider])

  const models = useMemo<ModelOption[]>(
    () => (liveModels.length > 0 ? liveModels : [...getModelsForProvider(provider)]),
    [liveModels, provider]
  )

  // A routine's saved model may be absent from the discovered list (e.g. CLI
  // catalog changed since) — keep it selectable rather than silently remapping.
  const modelOptions = useMemo<ModelOption[]>(
    () => (model && !models.some((m) => m.id === model) ? [{ id: model, label: model }, ...models] : models),
    [models, model]
  )

  const save = async () => {
    setError('')
    if (!name.trim()) return setError('Name is required.')
    if (!prompt.trim()) return setError('Prompt is required.')
    if (!locationId) return setError('Routines need a local location to host run worktrees.')

    let schedule: string | null = null
    if (triggerType === 'cron') {
      schedule = presetToCron(preset, time, weekday, customCron.trim())
      if (!schedule) return setError('Schedule is required.')
    } else if (triggerType === 'once') {
      const parsed = new Date(onceAt)
      if (Number.isNaN(parsed.getTime())) return setError('Pick a valid date and time.')
      schedule = parsed.toISOString()
    }

    const draft: RoutineDraft = {
      location_id: locationId,
      name: name.trim(),
      prompt: prompt.trim(),
      trigger_type: triggerType,
      schedule,
      provider,
      model,
      permission_mode: permissionMode,
      enabled,
    }

    setSaving(true)
    try {
      if (routine) await window.api.invoke('routines:update', routine.id, draft)
      else await window.api.invoke('routines:create', projectId, draft)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const labelStyle = { color: 'var(--color-text-muted)' }
  const inputClass = 'w-full rounded-md border px-2 py-1.5 text-xs'
  const inputStyle = { background: 'var(--color-bg)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className="relative flex flex-col rounded-xl shadow-2xl"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          width: 520,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
        }}
      >
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--color-border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {routine ? 'Edit Routine' : 'New Routine'}
          </h2>
          <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100" style={{ color: 'var(--color-text)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4 text-xs">
          <label className="flex flex-col gap-1">
            <span style={labelStyle}>Name</span>
            <input className={inputClass} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning issue triage" />
          </label>

          <label className="flex flex-col gap-1">
            <span style={labelStyle}>Prompt</span>
            <textarea
              className={inputClass}
              style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Review all outstanding YouTrack issues and respond with a comment…"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span style={labelStyle}>Location (run worktrees are created beside this checkout)</span>
            <select className={inputClass} style={inputStyle} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.length === 0 && <option value="">No eligible local locations</option>}
              {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span style={labelStyle}>Provider</span>
              <select
                className={inputClass}
                style={inputStyle}
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as Provider
                  setProvider(next)
                  setModel(getDefaultModelForProvider(next))
                }}
              >
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span style={labelStyle}>Model</span>
              <select className={inputClass} style={inputStyle} value={model} onChange={(e) => setModel(e.target.value)}>
                {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span style={labelStyle}>Execution mode</span>
            <select className={inputClass} style={inputStyle} value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}>
              <option value="yolo">Yolo — run fully autonomous</option>
              <option value="workspace">Workspace — workspace edits allowed, rest escalates</option>
              <option value="ask">Ask — every permission escalates the run</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span style={labelStyle}>Trigger</span>
            <select className={inputClass} style={inputStyle} value={triggerType} onChange={(e) => setTriggerType(e.target.value as RoutineTriggerType)}>
              <option value="cron">On a schedule</option>
              <option value="once">Once, at a set time</option>
              <option value="manual">Manually only</option>
            </select>
          </label>

          {triggerType === 'cron' && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span style={labelStyle}>Repeat</span>
                <select className={inputClass} style={inputStyle} value={preset} onChange={(e) => setPreset(e.target.value as SchedulePreset)}>
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Weekly</option>
                  <option value="hourly">Hourly</option>
                  <option value="custom">Custom cron</option>
                </select>
              </label>
              {preset === 'weekly' && (
                <label className="flex flex-col gap-1">
                  <span style={labelStyle}>Day</span>
                  <select className={inputClass} style={inputStyle} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                    {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
                  </select>
                </label>
              )}
              {preset !== 'custom' && (
                <label className="flex flex-col gap-1">
                  <span style={labelStyle}>{preset === 'hourly' ? 'At minute (of :MM)' : 'Time'}</span>
                  <input type="time" className={inputClass} style={inputStyle} value={time} onChange={(e) => setTime(e.target.value)} />
                </label>
              )}
              {preset === 'custom' && (
                <label className="flex flex-1 flex-col gap-1">
                  <span style={labelStyle}>Cron (min hour dom month dow, local time)</span>
                  <input className={inputClass} style={inputStyle} value={customCron} onChange={(e) => setCustomCron(e.target.value)} placeholder="0 8 * * 1-5" />
                </label>
              )}
            </div>
          )}

          {triggerType === 'once' && (
            <label className="flex flex-col gap-1">
              <span style={labelStyle}>Run at (fires once, then the routine disables itself)</span>
              <input type="datetime-local" className={inputClass} style={inputStyle} value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
            </label>
          )}

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span style={{ color: 'var(--color-text)' }}>Enabled</span>
          </label>

          {error && <p style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--color-border)' }}>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-xs"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: 'var(--color-accent, #2563eb)', color: '#fff' }}
          >
            {routine ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
