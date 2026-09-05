import { useEffect, useState } from 'react'
import { getModelsForProvider, PROVIDERS, type ModelOption, type Provider } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'

type ModelsChannel =
  | 'models:claudeAvailable'
  | 'models:codexAvailable'
  | 'models:opencodeAvailable'
  | 'models:piAvailable'
  | 'models:cursorAvailable'
  | 'models:grokAvailable'

export const MODEL_CHANNEL_BY_PROVIDER: Record<Provider, ModelsChannel> = {
  'claude-code': 'models:claudeAvailable',
  codex: 'models:codexAvailable',
  opencode: 'models:opencodeAvailable',
  pi: 'models:piAvailable',
  cursor: 'models:cursorAvailable',
  grok: 'models:grokAvailable',
}

export function isProvider(value: string): value is Provider {
  return PROVIDERS.some((p) => p.id === value)
}

/** Human label for a model id, falling back to the id for models the static catalog does not know. */
export function modelLabel(provider: string, model: string): string {
  const options = isProvider(provider) ? getModelsForProvider(provider) : []
  return options.find((option) => option.id === model)?.label ?? model
}

/**
 * The provider's models: the host's live list once it answers, the static
 * catalog until then (and forever, if the provider CLI is unavailable).
 * `threadId` lets the host resolve per-thread environment (WSL distro etc.).
 */
export function useAvailableModels(provider: Provider, threadId?: string | null, enabled = true): ModelOption[] {
  const [live, setLive] = useState<{ provider: Provider; models: ModelOption[] } | null>(null)

  useEffect(() => {
    if (!enabled) return
    const connection = useHostsStore.getState().activeConnection()
    if (!connection) return
    let cancelled = false
    rpc(connection, MODEL_CHANNEL_BY_PROVIDER[provider], threadId ?? null)
      .then((available) => {
        if (!cancelled && Array.isArray(available) && available.length > 0) {
          setLive({ provider, models: available })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled, provider, threadId])

  return live?.provider === provider ? live.models : [...getModelsForProvider(provider)]
}
