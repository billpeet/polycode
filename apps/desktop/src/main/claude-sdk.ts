/**
 * Lightweight Claude Agent SDK wrapper for fallback text generation.
 * Uses Haiku 4.5 for fast, cost-effective completions without spawning CLI processes.
 */

export interface SimpleQueryOptions {
  model?: string
  maxTurns?: number
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
  }
  return queryFn
}

/** Run a simple text completion with no tools. */
export async function simpleQuery(
  prompt: string,
  options: SimpleQueryOptions = {},
): Promise<string> {
  const { model = DEFAULT_MODEL, maxTurns = 1 } = options
  const query = await getQuery()
  let result = ''

  for await (const message of query({
    prompt,
    options: {
      model,
      maxTurns,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
    },
  })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text') result += block.text
      }
    }
    if (message.type === 'result' && message.subtype === 'success' && message.result && !result) {
      result = message.result
    }
  }

  return result.trim()
}
