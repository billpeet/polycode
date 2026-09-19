import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputEvent } from '../../../shared/types'
import type { DriverOptions, MessageOptions } from '../types'
import type { SpawnCommand } from '../runner'

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
let child: FakeChild
let command: SpawnCommand
let initialize: Record<string, unknown>
let replay = false
let rejectModel = false
let holdInitialize = false
const drivers: KimiDriver[] = []

vi.mock('../process-control', () => ({ killWindowsProcessTree: vi.fn() }))
vi.mock('../runner', () => ({
  FIX_HOME: 'fix-home', LOAD_NODE_MANAGERS: 'load-node',
  createRunner: () => ({ spawn: (cmd: SpawnCommand) => { command = cmd; child = new FakeChild(); return child } }),
}))
import { KimiDriver } from '../kimi'
import { kimiModels, kimiQuestions } from '../kimi-acp'
import { listKimiAvailableModels } from '../../kimi-models'

function config() {
  return [
    { id: 'model', type: 'select', currentValue: 'kimi-code', options: [{ value: 'kimi-code', name: 'Kimi' }, { value: 'other', name: 'Other' }] },
    { id: 'thinking', type: 'select', currentValue: 'on', options: [{ value: 'off' }, { value: 'on' }] },
    { id: 'mode', type: 'select', currentValue: 'default', options: ['default', 'auto', 'yolo', 'plan'].map((value) => ({ value })) },
  ]
}
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 1234
  killed = false
  written: Rpc[] = []
  config = config()
  stdin = { writable: true, end: vi.fn(), write: (data: string) => {
    const message = JSON.parse(data) as Rpc
    this.written.push(message)
    if (!message.method || message.id === undefined || message.method === 'session/prompt' || (holdInitialize && message.method === 'initialize')) return true
    setImmediate(() => {
      let result: unknown = {}
      if (message.method === 'initialize') result = initialize
      if (['session/new', 'session/resume', 'session/load'].includes(message.method!)) {
        if (replay) this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history' } })
        result = { sessionId: 'session-1', configOptions: this.config }
      }
      if (message.method === 'session/set_config_option') {
        if (rejectModel) { this.send({ id: message.id, error: { code: -32602, message: 'Model unavailable' } }); return }
        this.config = this.config.map((option) => option.id === message.params?.configId ? { ...option, currentValue: String(message.params.value) } : option)
        result = { configOptions: this.config }
      }
      this.send({ id: message.id, result })
    })
    return true
  } }
  send(message: Rpc) { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  update(update: Record<string, unknown>) { this.send({ method: 'session/update', params: { sessionId: 'session-1', update } }) }
  requests(method: string) { return this.written.filter((message) => message.method === method) }
  kill() { this.killed = true; return true }
  complete(stopReason = 'end_turn') { this.send({ id: this.requests('session/prompt').at(-1)!.id, result: { stopReason } }) }
}
function driver(options: Partial<DriverOptions> = {}) {
  const instance = new KimiDriver({ workingDir: 'C:/repo', threadId: 'thread-1', ...options })
  drivers.push(instance)
  return instance
}
function turn(instance: KimiDriver, options?: MessageOptions) {
  const events: OutputEvent[] = []
  const done = vi.fn()
  instance.sendMessage('Hello', (event) => events.push(event), done, options)
  return { events, done }
}
async function prompted() { await vi.waitFor(() => expect(child.requests('session/prompt').length).toBeGreaterThan(0)) }

beforeEach(() => {
  initialize = { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '2.0.0' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, delete: {} }, promptCapabilities: { image: true } } }
  replay = false; rejectModel = false; holdInitialize = false
})
afterEach(() => { drivers.splice(0).forEach((instance) => instance.forceStop()); vi.useRealTimers() })

describe('Kimi Code ACP', () => {
  it('distinguishes Moonshot API models from coding-service models and identifies the CLI default', () => {
    const models = kimiModels([{ id: 'model', currentValue: 'moonshot-ai/kimi-k3', options: [
      { value: 'kimi-code/k3', name: 'K3' },
      { value: 'moonshot-ai/kimi-k3', name: 'kimi-k3' },
    ] }])
    expect(models.map(({ label }) => label)).toEqual([
      'CLI default (Moonshot API: kimi-k3)', 'Kimi Code: K3', 'Moonshot API: kimi-k3',
    ])
    expect(models.map(({ id }) => id)).toEqual(['default', 'kimi-code/k3', 'moonshot-ai/kimi-k3'])
  })
  it('keeps a persistent peer, streams split frames and accepts context usage after completion', async () => {
    const instance = driver()
    const { events, done } = turn(instance)
    await prompted()
    expect(command).toMatchObject({ binary: 'kimi', args: ['acp'], keepStdinOpen: true, workDir: 'C:/repo' })
    const frame = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } } } })
    child.stdout.write(frame.slice(0, 23)); child.stdout.write(frame.slice(23) + '\n')
    child.complete()
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    child.update({ sessionUpdate: 'usage_update', used: 42, size: 1000 })
    expect(events).toContainEqual({ type: 'thinking', content: 'Thinking', metadata: { type: 'thinking' } })
    expect(events.at(-1)).toEqual({ type: 'usage', content: '', metadata: { context_window: 42, max_context_window: 1000 } })
    expect(child.killed).toBe(false)
    turn(instance)
    await vi.waitFor(() => expect(child.requests('session/prompt')).toHaveLength(2))
    child.complete()
  })

  it.each([true, false])('resumes existing sessions without duplicating replay, resume capability=%s', async (resume) => {
    if (!resume) initialize.agentCapabilities = { loadSession: true }
    replay = true
    const { events, done } = turn(driver({ initialSessionId: 'session-1' }))
    await prompted()
    expect(child.requests(resume ? 'session/resume' : 'session/load')).toHaveLength(1)
    expect(events).toEqual([])
    child.complete()
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
  })

  it('rejects legacy Kimi and cleans up failed startup', async () => {
    initialize.agentInfo = { name: 'Kimi CLI' }
    const { done } = turn(driver())
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Legacy') })))
    expect(child.killed).toBe(true)
    expect(child.requests('session/new')).toHaveLength(0)
  })

  it('tolerates an SSH or WSL login banner before the first protocol response', async () => {
    const instance = driver({ wsl: { distro: 'Ubuntu' } })
    turn(instance)
    child.stdout.write('Welcome to Ubuntu\n\n')
    await prompted()
    expect(instance.isRunning()).toBe(true)
  })

  it('applies explicit models, thinking and plan mode and never silently substitutes a rejected model', async () => {
    const { done } = turn(driver({ model: 'other', kimiThinking: 'off' }), { planMode: true, permissionMode: 'yolo' })
    await prompted()
    expect(child.requests('session/set_config_option').map((message) => message.params)).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'other' },
      { sessionId: 'session-1', configId: 'thinking', value: 'off' },
      { sessionId: 'session-1', configId: 'mode', value: 'plan' },
    ])
    child.complete()
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    rejectModel = true
    const failed = turn(driver({ model: 'other' }))
    await vi.waitFor(() => expect(failed.done).toHaveBeenCalledWith(expect.objectContaining({ message: 'Model unavailable' })))
    expect(child.requests('session/prompt')).toHaveLength(0)
  })

  it('retains tool input across partial updates and emits one call/result', async () => {
    const { events } = turn(driver())
    await prompted()
    child.update({ sessionUpdate: 'tool_call', toolCallId: '1:edit', kind: 'edit', title: 'Editing file', status: 'pending' })
    child.update({ sessionUpdate: 'tool_call_update', toolCallId: '1:edit', rawInput: { path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, status: 'in_progress' })
    child.update({ sessionUpdate: 'tool_call_update', toolCallId: '1:edit', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Saved' } }] })
    child.update({ sessionUpdate: 'tool_call_update', toolCallId: '1:edit', status: 'completed' })
    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(1)
    expect(events[0].metadata?.input).toMatchObject({ file_path: '/repo/a.ts', new_string: 'b' })
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(1)
    expect(events.at(-1)?.content).toBe('Saved')
  })

  it('uses offered permission IDs and never auto-answers a plan or question in Yolo', async () => {
    const instance = driver()
    const { events } = turn(instance, { permissionMode: 'yolo' })
    await prompted()
    child.send({ id: 'approval', method: 'session/request_permission', params: { toolCall: { title: 'Bash', rawInput: { command: 'pwd' } }, options: [
      { optionId: 'approve_once', kind: 'allow_once', name: 'Approve' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ] } })
    instance.sendControlResponse('approval', 'deny')
    expect(child.written.at(-1)).toMatchObject({ id: 'approval', result: { outcome: { outcome: 'selected', optionId: 'reject' } } })
    child.send({ id: 'plan', method: 'session/request_permission', params: { toolCall: { title: 'Plan review' }, options: [
      { optionId: 'plan_approve', kind: 'allow_once', name: 'Approve' }, { optionId: 'plan_revise', kind: 'reject_once', name: 'Revise' },
    ] } })
    expect(events.at(-1)?.type).toBe('question')
    expect(child.written.some((message) => message.id === 'plan')).toBe(false)
    instance.answerStructuredQuestion('plan', { choice: 'Revise' })
    expect(child.written.at(-1)).toMatchObject({ id: 'plan', result: { outcome: { outcome: 'selected', optionId: 'plan_revise' } } })
  })

  it('preserves stable form keys and multi-select arrays, and queues concurrent questions', async () => {
    const instance = driver()
    const { events } = turn(instance)
    await prompted()
    const params = { mode: 'form', requestedSchema: { type: 'object', properties: {
      q0: { type: 'array', title: 'Pick', items: { anyOf: [{ const: 'A, B' }, { const: 'C' }] } },
      q1: { type: 'string', title: 'Pick', oneOf: [{ const: 'Yes' }] },
    } } }
    child.send({ id: 91, method: 'elicitation/create', params })
    child.send({ id: 92, method: 'elicitation/create', params })
    expect(events.filter((event) => event.type === 'question')).toHaveLength(1)
    expect(() => instance.answerStructuredQuestion('91', { q0: ['A, B'], q1: 'Other' })).toThrow('offered answer')
    instance.answerStructuredQuestion('91', { q0: ['A, B', 'C'], q1: 'Yes' })
    expect(child.written.at(-1)).toMatchObject({ id: 91, result: { action: 'accept', content: { q0: ['A, B', 'C'], q1: 'Yes' } } })
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'question')).toHaveLength(2))
  })

  it('declines unsupported forms instead of leaving a server request hanging', async () => {
    turn(driver())
    await prompted()
    child.send({ id: 8, method: 'elicitation/create', params: { mode: 'url' } })
    expect(child.written.at(-1)).toMatchObject({ id: 8, result: { action: 'decline' } })
  })

  it('cancels using a notification and force stops after a bounded grace period', async () => {
    const instance = driver()
    const { done } = turn(instance)
    await prompted()
    vi.useFakeTimers()
    instance.stop()
    expect(child.requests('session/cancel')[0].id).toBeUndefined()
    await vi.advanceTimersByTimeAsync(3001)
    expect(child.killed).toBe(true)
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined)
    child.emit('exit', 1)
    expect(done).toHaveBeenCalledOnce()
  })

  it('never sends a prompt after stop during initialization, even if its response arrives late', async () => {
    holdInitialize = true
    const instance = driver()
    const { done } = turn(instance)
    instance.stop()
    child.send({ id: child.requests('initialize')[0].id, result: initialize })
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toHaveBeenCalledOnce()
    expect(child.requests('session/new')).toHaveLength(0)
    expect(child.requests('session/prompt')).toHaveLength(0)
  })

  it('settles process-exit failures immediately and rejects refusal as an error', async () => {
    const { done } = turn(driver())
    await prompted()
    child.emit('exit', 12)
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('exited (12)') }))
    const refused = turn(driver())
    await prompted()
    child.complete('refusal')
    await vi.waitFor(() => expect(refused.done).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('refused') })))
  })

  it('sends embedded images and rejects remote filesystem attachments explicitly', async () => {
    turn(driver(), { attachments: [{ url: 'data:image/png;base64,YQ==' }] })
    await prompted()
    expect(child.requests('session/prompt')[0].params?.prompt).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'YQ==' })
    const remote = turn(driver({ wsl: { distro: 'Ubuntu' } }), { attachments: [{ path: 'C:/a.png' }] })
    await vi.waitFor(() => expect(remote.done).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('embedded image data') })))
  })

  it('discovers configured models and deletes only the empty probe session', async () => {
    const models = await listKimiAvailableModels({ cwd: 'C:/model-probe', model: 'other' })
    expect(models.find((model) => model.id === 'other')?.thinkingOptions).toEqual([{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }])
    expect(child.requests('session/prompt')).toHaveLength(0)
    expect(child.requests('session/delete')[0].params).toEqual({ sessionId: 'session-1' })
    expect(child.killed).toBe(true)
  })

  it('only advertises thinking values for the inspected model', () => {
    expect(kimiModels(config()).find((model) => model.id === 'other')?.thinkingOptions).toBeUndefined()
    expect(() => kimiQuestions({ mode: 'form', requestedSchema: { type: 'object', properties: { q: { type: 'number' } } } })).toThrow('Unsupported')
    expect(kimiQuestions({ mode: 'form', message: 'Which folders should I edit?', requestedSchema: { type: 'object', properties: {
      q0: { type: 'string', title: 'Scope', oneOf: [{ const: 'All' }] },
    } } })[0]).toMatchObject({ header: 'Scope', question: 'Which folders should I edit?' })
  })
})
