import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ModelOption, PROVIDERS, Provider, Thread } from '../../types/ipc'
import { client } from '../../lib/client'

const DISCOVERY_CHANNEL = {
  'claude-code': 'models:claudeAvailable',
  codex: 'models:codexAvailable',
  opencode: 'models:opencodeAvailable',
  pi: 'models:piAvailable',
  cursor: 'models:cursorAvailable',
  grok: 'models:grokAvailable',
  'kimi-code': 'models:kimiAvailable',
} as const satisfies Record<Provider, string>

export interface ProviderDiscovery {
  /** Live models from the provider CLI; empty until (and unless) discovery succeeds. */
  models: ModelOption[]
  loading: boolean
  error: string | null
  retry: () => void
}

interface Settled {
  /** Identifies the thread environment the models were discovered in. */
  baseKey: string
  /** `baseKey` plus the retry counter: which request produced this result. */
  requestKey: string
  models: ModelOption[]
  error: string | null
}

const EMPTY: ModelOption[] = []

function baseKeyFor(provider: Provider, threadId: string, thread: Thread | undefined): string {
  const location = `${threadId}:${thread?.use_wsl}:${thread?.wsl_distro}`
  // Kimi discovery is parameterised by the thread's current Kimi model.
  return provider === 'kimi-code' ? `${location}:${thread?.provider === 'kimi-code' ? thread.model : ''}` : location
}

/**
 * Live model discovery for every provider in `active`: the thread's own
 * provider plus whichever tab the model browser is showing. Results are keyed
 * by the thread's execution environment, so switching thread or WSL distro
 * never shows another environment's catalogue.
 */
export function useProviderModels(
  threadId: string,
  thread: Thread | undefined,
  active: readonly (Provider | null | undefined)[],
): Record<Provider, ProviderDiscovery> {
  const [settled, setSettled] = useState<Partial<Record<Provider, Settled>>>({})
  const [retries, setRetries] = useState<Partial<Record<Provider, number>>>({})
  const latestRequest = useRef<Partial<Record<Provider, string>>>({})
  const forceRefresh = useRef<Set<Provider>>(new Set())

  const requestKeys = useMemo(() => {
    const keys = {} as Record<Provider, { base: string; request: string }>
    for (const { id } of PROVIDERS) {
      const base = baseKeyFor(id, threadId, thread)
      keys[id] = { base, request: `${base}:${retries[id] ?? 0}` }
    }
    return keys
  }, [threadId, thread, retries])

  const activeProviders = [...new Set(active.filter((p): p is Provider => !!p))]
  const activeSignature = activeProviders.map((p) => `${p}=${requestKeys[p].request}`).join('|')

  useEffect(() => {
    // Forget providers that went out of view so opening their tab again
    // revalidates (the main process caches, so this is cheap) while still
    // showing the models discovered last time.
    for (const provider of Object.keys(latestRequest.current) as Provider[]) {
      if (!activeProviders.includes(provider)) delete latestRequest.current[provider]
    }
    for (const provider of activeProviders) {
      const { base, request } = requestKeys[provider]
      if (latestRequest.current[provider] === request) continue
      latestRequest.current[provider] = request
      const invocation = client.invoke(DISCOVERY_CHANNEL[provider], threadId, forceRefresh.current.delete(provider))
      const settle = (models: ModelOption[] | null, error: string | null): void => {
        if (latestRequest.current[provider] !== request) return
        setSettled((prev) => {
          const previous = prev[provider]
          // A failed refresh keeps the models already discovered for this environment.
          const kept = models ?? (previous?.baseKey === base ? previous.models : EMPTY)
          return { ...prev, [provider]: { baseKey: base, requestKey: request, models: kept, error } }
        })
      }
      invocation.then(
        (models) => settle(models, provider === 'pi' && models.length === 0 ? 'Pi returned no available models' : null),
        (error: unknown) => settle(null, error instanceof Error ? error.message : String(error)),
      )
    }
    // activeSignature captures every input that should trigger a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSignature])

  const retry = useCallback((provider: Provider) => {
    forceRefresh.current.add(provider)
    setRetries((prev) => ({ ...prev, [provider]: (prev[provider] ?? 0) + 1 }))
  }, [])

  return useMemo(() => {
    const result = {} as Record<Provider, ProviderDiscovery>
    for (const { id } of PROVIDERS) {
      const entry = settled[id]
      const { base, request } = requestKeys[id]
      const isActive = activeProviders.includes(id)
      const current = entry?.requestKey === request
      result[id] = {
        models: entry?.baseKey === base ? entry.models : EMPTY,
        loading: isActive && !current,
        error: current ? entry.error : null,
        retry: () => retry(id),
      }
    }
    return result
    // activeSignature stands in for activeProviders, which is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, requestKeys, activeSignature, retry])
}
