/**
 * GrokDriver tests: a scripted fake `grok agent stdio` ACP server on the other
 * side of stdin/stdout. Cursor (the other persistent-ACP driver) shipped
 * without such a harness; Grok's xAI extensions — auth-method fallback,
 * `_x.ai/ask_user_question`, and the `_x.ai/session/prompt_complete` race —
 * are exactly the kind of dialect quirks that regress silently without one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { OutputEvent } from '../../../shared/types'
import type { DriverOptions } from '../types'
import type { SpawnCommand } from '../runner'

const spawnedCommands: SpawnCommand[] = []
let currentChild: FakeAcpChild | null = null

vi.mock('../runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner')>()
  return {
    ...actual,
    createRunner: () => ({
      type: 'local' as const,
      spawn: (cmd: SpawnCommand) => {
        spawnedCommands.push(cmd)
        currentChild = new FakeAcpChild()
        return currentChild as never
      },
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
      spawnScript: () => { throw new Error('not used') },
      runScript: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    }),
  }
})

// Import after the mock so the driver sees the fake runner factory.
import { GrokDriver } from '../grok'

type JsonRpc = {
  jsonrpc?: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string; code?: number }
}

type Responder = (message: JsonRpc) => unknown

/** Fake child: records client messages and answers via scripted responders. */
class FakeAcpChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 4242
  killed = false
  /** Every JSON-RPC message the driver wrote, in order. */
  readonly written: JsonRpc[] = []
  /** method → responder. A responder throwing produces a JSON-RPC error. */
  readonly responders = new Map<string, Responder>()
  /**
   * Requests left unanswered until the test responds by hand. `session/prompt`
   * stays open by default — a turn ends when the test says so, which is what
   * lets the permission/question/fallback flows exist at all.
   */
  readonly silentMethods = new Set<string>(['session/prompt'])

  stdin = {
    writable: true,
    write: (data: string): boolean => {
      for (const line of data.split('\n')) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as JsonRpc
        this.written.push(message)
        if (message.method && message.id !== undefined && !this.silentMethods.has(message.method)) {
          // Resolve the responder inside the tick so tests attaching responders
          // on setImmediate always win the race against the auto-ack.
          setImmediate(() => {
            const responder = this.responders.get(message.method!)
            if (!responder) {
              this.send({ jsonrpc: '2.0', id: message.id, result: {} })
              return
            }
            try {
              this.send({ jsonrpc: '2.0', id: message.id, result: responder(message) })
            } catch (error) {
              this.send({ jsonrpc: '2.0', id: message.id, error: { message: error instanceof Error ? error.message : String(error), code: -32000 } })
            }
          })
        }
      }
      return true
    },
  }

  send(message: JsonRpc): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  requests(method: string): JsonRpc[] {
    return this.written.filter((message) => message.method === method)
  }
}

function makeDriver(opts: Partial<DriverOptions> = {}): GrokDriver {
  return new GrokDriver({
    workingDir: 'C:/repo',
    threadId: 'test-thread',
    ...opts,
  })
}

/** Send a message and resolve once onDone fires. */
function runTurn(driver: GrokDriver, content = 'hello'): { done: Promise<Error | undefined>; events: OutputEvent[] } {
  const events: OutputEvent[] = []
  const done = new Promise<Error | undefined>((resolve) => {
    driver.sendMessage(content, (event) => events.push(event), (error) => resolve(error))
  })
  return { done, events }
}

/** Wait for the in-flight session/prompt and resolve it, ending the turn. */
async function completePrompt(result: unknown = { stopReason: 'end_turn' }): Promise<void> {
  await vi.waitFor(() => {
    expect(currentChild?.requests('session/prompt')).toHaveLength(1)
  })
  currentChild!.send({ jsonrpc: '2.0', id: currentChild!.requests('session/prompt')[0].id, result })
}

function scriptDefaultSession(child: () => FakeAcpChild | null, setup: Record<string, unknown> = {}): void {
  // Responders are attached lazily on first write, but the child only exists
  // after sendMessage spawns it — so poll the accessor inside each responder.
  const attach = (): void => {
    const c = child()
    if (!c) {
      setImmediate(attach)
      return
    }
    c.responders.set('session/new', () => ({ sessionId: 'grok-session-1', ...setup }))
  }
  attach()
}

beforeEach(() => {
  spawnedCommands.length = 0
  currentChild = null
  delete process.env.XAI_API_KEY
})

afterEach(() => {
  delete process.env.XAI_API_KEY
})

describe('handshake and turn lifecycle', () => {
  it('spawns `grok agent stdio` with the OAuth referrer env and runs initialize → authenticate → session/new → session/prompt', async () => {
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done, events } = runTurn(driver)

    // Stream an assistant chunk before the prompt resolves.
    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    currentChild!.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'grok-session-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } } },
    })
    currentChild!.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'grok-session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi there' } } },
    })
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'text')).toBe(true)
    })
    await completePrompt()

    const error = await done
    expect(error).toBeUndefined()

    expect(spawnedCommands[0]).toMatchObject({
      binary: 'grok',
      args: ['agent', 'stdio'],
      keepStdinOpen: true,
      extraEnv: { GROK_OAUTH2_REFERRER: 'polycode' },
    })
    expect(spawnedCommands[0].preamble).toContain('export GROK_OAUTH2_REFERRER=polycode')

    const methods = currentChild!.written.map((message) => message.method)
    expect(methods).toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: 'Hi there' }))
    // metadata.type is what the renderer and the persisted-message path key on
    // — a thinking event without it renders as a regular assistant bubble.
    expect(events).toContainEqual(expect.objectContaining({
      type: 'thinking',
      content: 'pondering',
      metadata: { type: 'thinking' },
    }))
  })

  it('reports the created session id and prompts with a _meta.promptId for the completion fallback', async () => {
    let sessionId: string | undefined
    const driver = makeDriver({ onSessionId: (id) => { sessionId = id } })
    scriptDefaultSession(() => currentChild)
    const { done } = runTurn(driver)
    await completePrompt()
    await done

    expect(sessionId).toBe('grok-session-1')
    const prompt = currentChild!.requests('session/prompt')[0]
    expect(prompt.params?.sessionId).toBe('grok-session-1')
    expect(prompt.params?.prompt).toEqual([{ type: 'text', text: 'hello' }])
    const meta = prompt.params?._meta as Record<string, unknown>
    expect(typeof meta.promptId).toBe('string')
  })

  it('resumes with session/load when an initial session id is present', async () => {
    const driver = makeDriver({ initialSessionId: 'grok-session-9' })
    const attach = (): void => {
      if (!currentChild) return void setImmediate(attach)
      currentChild.responders.set('session/load', (message) => {
        expect(message.params?.sessionId).toBe('grok-session-9')
        return { sessionId: 'grok-session-9' }
      })
    }
    attach()
    const { done } = runTurn(driver)
    await completePrompt()
    await done

    expect(currentChild!.requests('session/load')).toHaveLength(1)
    expect(currentChild!.requests('session/new')).toHaveLength(0)
  })
})

describe('authentication', () => {
  it('leads with the grok login token cache and falls back to the API-key method', async () => {
    const driver = makeDriver()
    const attach = (): void => {
      if (!currentChild) return void setImmediate(attach)
      currentChild.responders.set('authenticate', (message) => {
        if ((message.params as { methodId?: string }).methodId === 'cached_token') {
          throw new Error('no cached token')
        }
        return {}
      })
      currentChild.responders.set('session/new', () => ({ sessionId: 'grok-session-1' }))
    }
    attach()
    const { done } = runTurn(driver)
    await completePrompt()
    const error = await done

    expect(error).toBeUndefined()
    const methodIds = currentChild!.requests('authenticate').map((message) => (message.params as { methodId: string }).methodId)
    expect(methodIds).toEqual(['cached_token', 'xai.api_key'])
  })

  it('prefers xai.api_key when XAI_API_KEY is set locally', async () => {
    process.env.XAI_API_KEY = 'xai-test-key'
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done } = runTurn(driver)
    await completePrompt()
    await done

    const methodIds = currentChild!.requests('authenticate').map((message) => (message.params as { methodId: string }).methodId)
    expect(methodIds).toEqual(['xai.api_key'])
  })
})

describe('model selection', () => {
  it('switches via session/set_model when the requested model differs from the session default', async () => {
    const driver = makeDriver({ model: 'grok-code-2' })
    scriptDefaultSession(() => currentChild, {
      models: { currentModelId: 'grok-build', availableModels: [{ modelId: 'grok-build' }, { modelId: 'grok-code-2' }] },
    })
    const { done } = runTurn(driver)
    await completePrompt()
    await done

    const setModel = currentChild!.requests('session/set_model')
    expect(setModel).toHaveLength(1)
    expect(setModel[0].params).toMatchObject({ sessionId: 'grok-session-1', modelId: 'grok-code-2' })
  })

  it('skips the switch when the session is already on the requested model', async () => {
    const driver = makeDriver({ model: 'grok-build' })
    scriptDefaultSession(() => currentChild, {
      models: { currentModelId: 'grok-build', availableModels: [{ modelId: 'grok-build' }] },
    })
    const { done } = runTurn(driver)
    await completePrompt()
    await done

    expect(currentChild!.requests('session/set_model')).toHaveLength(0)
  })
})

describe('permissions', () => {
  it('surfaces session/request_permission and answers with the option matching the decision kind', async () => {
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done, events } = runTurn(driver)

    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    currentChild!.silentMethods.add('session/request_permission')
    currentChild!.send({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'grok-session-1',
        toolCall: { toolCallId: 'tool-1', kind: 'execute', title: 'Run tests', rawInput: { command: 'pnpm test' } },
        options: [
          { optionId: 'opt-always', kind: 'allow_always' },
          { optionId: 'opt-once', kind: 'allow_once' },
          { optionId: 'opt-no', kind: 'reject_once' },
        ],
      },
    })

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'permission_request')).toBe(true)
    })
    const request = events.find((event) => event.type === 'permission_request')!
    expect(request.metadata).toMatchObject({ toolName: 'Run tests', toolInput: { command: 'pnpm test' } })

    driver.sendControlResponse(String(request.metadata!.requestId), 'allow')
    const response = currentChild!.written.find((message) => message.id === 'perm-1' && message.result !== undefined)
    expect(response?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } })

    currentChild!.send({ jsonrpc: '2.0', id: currentChild!.requests('session/prompt')[0].id, result: { stopReason: 'end_turn' } })
    await done
  })

  it('auto-approves with allow_always in yolo mode', async () => {
    const driver = makeDriver({ yoloMode: true })
    scriptDefaultSession(() => currentChild)
    const { done, events } = runTurn(driver)

    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    currentChild!.silentMethods.add('session/request_permission')
    currentChild!.send({
      jsonrpc: '2.0',
      id: 'perm-2',
      method: 'session/request_permission',
      params: {
        sessionId: 'grok-session-1',
        toolCall: { toolCallId: 'tool-2', kind: 'edit', title: 'Edit file' },
        options: [
          { optionId: 'opt-always', kind: 'allow_always' },
          { optionId: 'opt-once', kind: 'allow_once' },
        ],
      },
    })

    await vi.waitFor(() => {
      expect(currentChild!.written.some((message) => message.id === 'perm-2' && message.result !== undefined)).toBe(true)
    })
    const response = currentChild!.written.find((message) => message.id === 'perm-2' && message.result !== undefined)
    expect(response?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-always' } })
    expect(events.some((event) => event.type === 'permission_request')).toBe(false)

    currentChild!.send({ jsonrpc: '2.0', id: currentChild!.requests('session/prompt')[0].id, result: {} })
    await done
  })
})

describe('_x.ai/ask_user_question', () => {
  it('emits a question event and answers keyed by question text with selected labels', async () => {
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done, events } = runTurn(driver)

    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    currentChild!.silentMethods.add('_x.ai/ask_user_question')
    currentChild!.send({
      jsonrpc: '2.0',
      id: 'ask-1',
      method: '_x.ai/ask_user_question',
      params: {
        title: 'Deployment',
        questions: [{
          id: 'q-target',
          question: 'Which environment?',
          options: [{ id: 'staging', label: 'Staging' }, { id: 'prod', label: 'Production' }],
          multiSelect: false,
        }],
      },
    })

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'question')).toBe(true)
    })
    const question = events.find((event) => event.type === 'question')!
    expect(question.metadata!.questions).toEqual([
      expect.objectContaining({ id: 'q-target', question: 'Which environment?', multiSelect: false }),
    ])

    driver.answerQuestion(String(question.metadata!.requestId), { 'q-target': 'Staging' })
    const response = currentChild!.written.find((message) => message.id === 'ask-1' && message.result !== undefined)
    expect(response?.result).toEqual({ outcome: 'accepted', answers: { 'Which environment?': ['Staging'] } })

    currentChild!.send({ jsonrpc: '2.0', id: currentChild!.requests('session/prompt')[0].id, result: {} })
    await done
  })
})

describe('_x.ai/session/prompt_complete fallback', () => {
  it('finishes the turn when the notification arrives and the prompt RPC never resolves', async () => {
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done } = runTurn(driver)

    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    // The fake never responds to session/prompt (no responder registered would
    // auto-ack — suppress it) and instead emits the xAI completion notification.
    const prompt = currentChild!.requests('session/prompt')[0]
    const meta = prompt.params?._meta as { promptId: string }
    currentChild!.send({
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId: 'grok-session-1', _meta: { promptId: meta.promptId }, stopReason: 'end_turn' },
    })

    const error = await done
    expect(error).toBeUndefined()
  })

  it('ignores a completion notification for a different prompt id', async () => {
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done } = runTurn(driver)

    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    currentChild!.send({
      jsonrpc: '2.0',
      method: '_x.ai/session/prompt_complete',
      params: { sessionId: 'grok-session-1', _meta: { promptId: 'someone-else' } },
    })
    // The stale notification must not settle the turn; the real response does.
    currentChild!.send({ jsonrpc: '2.0', id: currentChild!.requests('session/prompt')[0].id, result: { stopReason: 'end_turn' } })

    const error = await done
    expect(error).toBeUndefined()
    expect(driver.isRunning()).toBe(false)
  })
})

describe('tool call surfacing', () => {
  it('emits tool_call once and tool_result on completion, carrying the ACP kind for canonical naming', async () => {
    const driver = makeDriver()
    scriptDefaultSession(() => currentChild)
    const { done, events } = runTurn(driver)

    await vi.waitFor(() => {
      expect(currentChild?.requests('session/prompt')).toHaveLength(1)
    })
    const update = (status: string): void => {
      currentChild!.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'grok-session-1',
          update: {
            sessionUpdate: status === 'pending' ? 'tool_call' : 'tool_call_update',
            toolCallId: 'tool-9',
            kind: 'execute',
            title: 'Terminal',
            status,
            rawInput: { command: 'ls' },
            ...(status === 'completed' ? { rawOutput: 'file-a\nfile-b' } : {}),
          },
        },
      })
    }
    update('pending')
    update('pending') // duplicate announcement must not re-emit
    update('completed')

    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'tool_result')).toBe(true)
    })
    const calls = events.filter((event) => event.type === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0].metadata).toMatchObject({ id: 'tool-9', name: 'Terminal', input: { command: 'ls' }, kind: 'execute' })
    const result = events.find((event) => event.type === 'tool_result')!
    expect(result.content).toBe('file-a\nfile-b')

    currentChild!.send({ jsonrpc: '2.0', id: currentChild!.requests('session/prompt')[0].id, result: {} })
    await done
  })
})
