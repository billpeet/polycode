import { DEFAULT_CONTEXT_LIMIT, MODEL_CONTEXT_LIMITS, resolveEffectiveModel } from '../types/ipc'

export function resolveDisplayedContextLimit(
  provider: string,
  model: string,
  contextSelection: string | null | undefined,
  reportedLimit: number | null | undefined,
): number {
  const effectiveModel = resolveEffectiveModel(provider, model, contextSelection)
  const selectedLimit = MODEL_CONTEXT_LIMITS[effectiveModel] ?? DEFAULT_CONTEXT_LIMIT

  // Claude's SDK can report the base model's 200k window even when the CLI is
  // running the explicitly selected `[1m]` variant. The selection is the
  // authoritative limit for Claude; other providers can report dynamic limits.
  if (provider === 'claude-code') return selectedLimit
  return reportedLimit && reportedLimit > 0 ? reportedLimit : selectedLimit
}
