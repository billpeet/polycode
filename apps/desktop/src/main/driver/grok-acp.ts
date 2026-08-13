import { ModelOption, Question } from '../../shared/types'
import { LOAD_NODE_MANAGERS } from './runner'

/**
 * Shared protocol constants and parsers for xAI's Grok Build CLI, which speaks
 * ACP (Agent Client Protocol) JSON-RPC over `grok agent stdio`. Mirrors
 * t3code's GrokAcpSupport: authentication is owned by the CLI itself — we only
 * pick an ACP auth *method id* (API key env vs `grok login` token cache) and
 * tag the OAuth flow with a referrer for attribution.
 */

export const GROK_BINARY = 'grok'
export const GROK_ACP_ARGS = ['agent', 'stdio']

export const GROK_API_KEY_ENV = 'XAI_API_KEY'
export const GROK_OAUTH2_REFERRER_ENV = 'GROK_OAUTH2_REFERRER'
export const GROK_OAUTH2_REFERRER = 'polycode'

export const GROK_AUTH_METHOD_API_KEY = 'xai.api_key'
export const GROK_AUTH_METHOD_CACHED_TOKEN = 'cached_token'

/** Default model slug when the CLI does not report a catalog. */
export const GROK_DEFAULT_MODEL_ID = 'grok-build'

export const GROK_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
}

export const GROK_CLIENT_INFO = { name: 'polycode', version: '0.13.0' }

/** Extra env for local spawns; remote transports get the same via preamble. */
export const GROK_SPAWN_EXTRA_ENV: Record<string, string> = {
  [GROK_OAUTH2_REFERRER_ENV]: GROK_OAUTH2_REFERRER,
}

/** Shell preamble for wsl/ssh spawns: node managers + OAuth referrer export. */
export const GROK_REMOTE_PREAMBLE = `${LOAD_NODE_MANAGERS}; export ${GROK_OAUTH2_REFERRER_ENV}=${GROK_OAUTH2_REFERRER}`

/**
 * Auth methods to try, in order. Locally we can see XAI_API_KEY and prefer it
 * (t3code's resolveGrokAuthMethodId); on remote transports the desktop cannot
 * inspect the remote env, so lead with the `grok login` token cache. Either
 * way the other method is kept as a fallback attempt.
 */
export function grokAuthMethodOrder(env: NodeJS.ProcessEnv, remote: boolean): string[] {
  const hasApiKey = !remote && !!env[GROK_API_KEY_ENV]?.trim()
  return hasApiKey
    ? [GROK_AUTH_METHOD_API_KEY, GROK_AUTH_METHOD_CACHED_TOKEN]
    : [GROK_AUTH_METHOD_CACHED_TOKEN, GROK_AUTH_METHOD_API_KEY]
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Parse the ACP session setup result's model state
 * (`{ models: { availableModels: [{ modelId, name?, description? }], currentModelId } }`)
 * into PolyCode's ModelOption shape.
 */
export function parseGrokSessionModels(setup: unknown): { models: ModelOption[]; currentModelId: string | null } {
  const setupRecord = asRecord(setup) ?? {}
  const modelState = asRecord(setupRecord.models) ?? {}
  const currentModelId = typeof modelState.currentModelId === 'string' && modelState.currentModelId.trim()
    ? modelState.currentModelId.trim()
    : null
  const available = Array.isArray(modelState.availableModels) ? modelState.availableModels : []
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const raw of available) {
    const rec = asRecord(raw)
    const id = typeof rec?.modelId === 'string' ? rec.modelId.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: typeof rec?.name === 'string' && rec.name.trim() ? rec.name.trim() : id })
  }
  return { models, currentModelId }
}

export type GrokRawQuestion = {
  id: string
  text: string
  options: Array<{ id: string; label: string }>
  multiSelect: boolean
}

/**
 * Normalize xAI's `_x.ai/ask_user_question` params. The CLI has shipped both a
 * bare `{ questions: [...] }` payload and a wrapped `{ method, params }` form
 * (t3code accepts both), and individual questions have used `question`/
 * `prompt`/`text` for the question text — be liberal in what we accept.
 */
export function parseGrokQuestionParams(params: Record<string, unknown>): { questions: Question[]; raw: GrokRawQuestion[]; title: string } {
  const wrapped = asRecord(params.params)
  const effective = wrapped && Array.isArray(wrapped.questions) ? wrapped : params
  const title = typeof effective.title === 'string' && effective.title.trim() ? effective.title.trim() : 'Question'
  const rawQuestions = Array.isArray(effective.questions) ? effective.questions : []

  const raw: GrokRawQuestion[] = rawQuestions.flatMap((entry, index) => {
    const q = asRecord(entry)
    if (!q) return []
    const text = [q.question, q.prompt, q.text].find((v): v is string => typeof v === 'string' && !!v.trim())?.trim() ?? `Question ${index + 1}`
    const options = Array.isArray(q.options) ? q.options.flatMap((rawOption) => {
      if (typeof rawOption === 'string' && rawOption.trim()) {
        return [{ id: rawOption.trim(), label: rawOption.trim() }]
      }
      const opt = asRecord(rawOption)
      const label = [opt?.label, opt?.name, opt?.id].find((v): v is string => typeof v === 'string' && !!v.trim())?.trim()
      if (!label) return []
      return [{ id: typeof opt?.id === 'string' && opt.id.trim() ? opt.id.trim() : label, label }]
    }) : []
    return [{
      id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q-${index}`,
      text,
      options,
      multiSelect: q.multiSelect === true || q.allowMultiple === true,
    }]
  })

  const questions: Question[] = raw.map((q) => ({
    id: q.id,
    header: title,
    question: q.text,
    multiSelect: q.multiSelect,
    options: q.options.length > 0
      ? q.options.map((option) => ({ label: option.label, description: option.label }))
      : [{ label: 'OK', description: 'Continue' }],
  }))

  return { questions, raw, title }
}

type PermissionOption = { optionId: string; kind: string }

/**
 * Pick the ACP permission option id for an allow/deny decision. Grok reports
 * its options with kinds (`allow_once`, `allow_always`, `reject_once`, ...);
 * select by kind and fall back to the conventional literals when the request
 * carried no options array (t3code maps accept→allow_once, reject→reject_once).
 */
export function selectGrokPermissionOptionId(
  options: unknown,
  behavior: 'allow' | 'deny',
  preferAlways = false,
): string {
  const parsed: PermissionOption[] = Array.isArray(options)
    ? options.flatMap((entry) => {
        const rec = asRecord(entry)
        const optionId = typeof rec?.optionId === 'string' ? rec.optionId : ''
        const kind = typeof rec?.kind === 'string' ? rec.kind : ''
        return optionId ? [{ optionId, kind }] : []
      })
    : []
  const byKind = (kind: string): string | undefined => parsed.find((option) => option.kind === kind)?.optionId
  if (behavior === 'allow') {
    return (preferAlways ? byKind('allow_always') : undefined) ?? byKind('allow_once') ?? byKind('allow_always') ?? 'allow_once'
  }
  return byKind('reject_once') ?? byKind('reject_always') ?? 'reject_once'
}
