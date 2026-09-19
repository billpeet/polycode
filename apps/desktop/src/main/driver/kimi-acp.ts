import type { ChildProcess } from 'child_process'
import readline from 'readline'
import { createRunner, FIX_HOME, LOAD_NODE_MANAGERS } from './runner'
import type { DriverOptions } from './types'
import { killWindowsProcessTree } from '../process-control'
import type { ModelOption, Question } from '../../shared/types'

export type RpcId = number | string
export type RecordValue = Record<string, unknown>
export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}
export function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : []
}
export function selectOptions(config: RecordValue): Array<{ value: string; name: string }> {
  return records(config.options).flatMap((option) => typeof option.value === 'string'
    ? [{ value: option.value, name: typeof option.name === 'string' ? option.name : option.value }]
    : selectOptions(option))
}
export function kimiConfig(setup: unknown): RecordValue[] {
  return records(record(setup).configOptions)
}
export function kimiModels(config: RecordValue[]): ModelOption[] {
  const model = config.find((option) => option.id === 'model') ?? {}
  const thinking = config.find((option) => option.id === 'thinking')
  const options = thinking ? selectOptions(thinking).map((option) => ({ value: option.value, label: option.name })) : []
  const label = (option: { value: string; name: string }): string => {
    if (option.value.startsWith('moonshot-ai/')) return `Moonshot API: ${option.name}`
    if (option.value.startsWith('kimi-code/')) return `Kimi Code: ${option.name}`
    return option.name
  }
  const selected = selectOptions(model).find((option) => option.value === model.currentValue)
  return [{ id: 'default', label: selected ? `CLI default (${label(selected)})` : 'CLI default', thinkingOptions: options }, ...selectOptions(model).map((option) => ({
    id: option.value, label: label(option),
    ...(option.value === model.currentValue ? { thinkingOptions: options } : {}),
  }))]
}

export function kimiQuestions(params: RecordValue): Question[] {
  if (params.mode !== 'form') throw new Error('Kimi requested an unsupported question format')
  const schema = record(params.requestedSchema)
  if (schema.type !== 'object') throw new Error('Kimi requested an unsupported question schema')
  const properties = record(schema.properties)
  const entries = Object.entries(properties)
  const prompts = typeof params.message === 'string' ? params.message.split('\n') : []
  const questions = entries.map(([id, raw], index) => {
    const field = record(raw)
    const multiSelect = field.type === 'array'
    if (field.type !== 'string' && !multiSelect) throw new Error('Unsupported Kimi question field')
    const choices = records(multiSelect ? record(field.items).anyOf : field.oneOf)
    if (!choices.length || choices.some((choice) => typeof choice.const !== 'string')) throw new Error('Unsupported Kimi question choices')
    return {
      id, header: String(field.title ?? id),
      question: [prompts.length === entries.length ? prompts[index] : String(params.message ?? field.title ?? id), field.description].filter(Boolean).join('\n'),
      multiSelect, allowComments: false,
      options: choices.map((choice) => ({ label: String(choice.const), description: String(choice.description ?? '') })),
    }
  })
  if (!questions.length) throw new Error('Kimi returned an empty question form')
  return questions
}

type Message = { jsonrpc?: string; id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Kimi's newline-delimited ACP connection. Tools execute in the CLI's environment. */
export class KimiConnection {
  private child: ChildProcess | null = null
  private lines: readline.Interface | null = null
  private pending = new Map<RpcId, Pending>()
  private nextId = 1
  private closed = false
  private stderr = ''
  private receivedFrame = false
  capabilities: RecordValue = {}

  constructor(
    private readonly options: Pick<DriverOptions, 'workingDir' | 'ssh' | 'wsl'>,
    private readonly onMessage: (method: string, params: RecordValue, id?: RpcId) => void,
    private readonly onExit: (error: Error) => void,
  ) {}

  get pid(): number | null { return this.child?.pid ?? null }

  async start(): Promise<void> {
    this.child = createRunner(this.options).spawn({
      binary: 'kimi', args: ['acp'], workDir: this.options.workingDir, keepStdinOpen: true,
      preamble: `${FIX_HOME}; ${LOAD_NODE_MANAGERS}; export PATH="$HOME/.local/bin:$PATH"`,
    })
    this.lines = readline.createInterface({ input: this.child.stdout! })
    this.lines.on('line', (line) => {
      if (this.closed) return
      let message: Message
      try { message = JSON.parse(line) as Message } catch {
        // SSH/WSL login shells can print a banner before exec starts the peer.
        if (this.receivedFrame) this.fail(new Error('Invalid JSON from Kimi Code ACP'))
        return
      }
      if (!message || message.jsonrpc !== '2.0') return
      this.receivedFrame = true
      if (message.method) {
        try { this.onMessage(message.method, record(message.params), message.id) }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.code === -32000
          ? `Kimi Code authentication required. Run kimi login at this Project Location. ${message.error.message}`
          : message.error.message))
        else pending.resolve(message.result)
      }
    })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4000) })
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code) => this.fail(new Error(`Kimi Code ACP exited (${code ?? 'signal'}). ${this.stderr}`)))
    const initialized = record(await this.request('initialize', {
      protocolVersion: 1, clientInfo: { name: 'polycode', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
    }))
    const info = record(initialized.agentInfo)
    if (info.name !== 'Kimi Code CLI' || Number.parseInt(String(info.version), 10) < 2 || !/^\d+\./.test(String(info.version)) || initialized.protocolVersion !== 1) {
      throw new Error('This integration requires Kimi Code CLI 2.0 or newer with ACP support. Legacy Kimi CLI is not supported.')
    }
    this.capabilities = record(initialized.agentCapabilities)
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Kimi Code connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for Kimi Code ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }) }
  respond(id: RpcId, result: unknown): void { this.write({ jsonrpc: '2.0', id, result }) }
  reject(id: RpcId, message: string): void { this.write({ jsonrpc: '2.0', id, error: { code: -32601, message } }) }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Kimi Code connection closed'))
    }
    this.pending.clear()
    this.lines?.close()
    const child = this.child
    this.child = null
    if (child) {
      if (process.platform === 'win32' && child.pid) killWindowsProcessTree(child.pid, { force: true })
      try { child.stdin?.end(); child.kill() } catch { /* Already exited. */ }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.onExit(error)
  }
  private write(message: Message): void {
    if (this.closed || !this.child?.stdin?.writable) throw new Error('Kimi Code stdin is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}
