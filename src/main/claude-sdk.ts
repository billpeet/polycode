/**
 * Lightweight Claude Agent SDK wrapper for basic tasks like title generation.
 * Uses Haiku 4.5 for fast, cost-effective completions without spawning CLI processes.
 */

export interface SimpleQueryOptions {
  model?: string
  maxTurns?: number
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// Lazy-load the ESM SDK module
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query | null = null

async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    queryFn = sdk.query
  }
  return queryFn
}

/**
 * Run a simple text completion with no tools.
 * Returns the accumulated text response.
 */
export async function simpleQuery(
  prompt: string,
  options: SimpleQueryOptions = {}
): Promise<string> {
  const { model = DEFAULT_MODEL, maxTurns = 1 } = options
  const query = await getQuery()

  let result = ''

  for await (const message of query({
    prompt,
    options: {
      model,
      maxTurns,
      allowedTools: [], // No tools needed for simple text generation
      permissionMode: 'bypassPermissions'
    }
  })) {
    // Extract text from assistant messages
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          result += block.text
        }
      }
    }
    // Also capture result message if present
    if (message.type === 'result' && message.subtype === 'success') {
      // The result field contains the final output
      if (message.result && !result) {
        result = message.result
      }
    }
  }

  return result.trim()
}

/**
 * Generate a short title for a thread based on the initial message.
 */
export async function generateTitle(seedMessage: string): Promise<string> {
  const prompt =
    `In 5 words or fewer, write a short title for a coding session that started with this request. ` +
    `Reply with ONLY the title, no quotes, no punctuation at the end:\n\n${seedMessage.slice(0, 500)}`

  const title = await simpleQuery(prompt)
  return title.slice(0, 60) // Ensure reasonable length
}
