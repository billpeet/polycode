import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.fn()

vi.mock('../driver/runner', () => ({
  createRunner: () => ({ spawn }),
}))

function mockPiProcess(onRequest: (request: Record<string, unknown>, proc: EventEmitter & Record<string, any>) => void) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        onRequest(JSON.parse(chunk.toString()), proc)
        callback()
      },
    }),
  })
  return proc
}

describe('listPiAvailableModels', () => {
  beforeEach(() => {
    vi.resetModules()
    spawn.mockReset()
  })

  it('retries Pi after a transient discovery failure instead of caching an empty list', async () => {
    spawn
      .mockImplementationOnce(() => mockPiProcess((_request, proc) => {
        queueMicrotask(() => proc.emit('error', new Error('temporary startup failure')))
      }))
      .mockImplementationOnce(() => mockPiProcess((request, proc) => {
        const response = JSON.stringify({
          id: request.id,
          type: 'response',
          command: 'get_available_models',
          success: true,
          data: {
            models: [{
              provider: 'openai-codex',
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              reasoning: true,
              contextWindow: 272000,
            }],
          },
        }) + '\n'
        queueMicrotask(() => {
          proc.stdout.write(response.slice(0, 17))
          proc.stdout.write(response.slice(17))
        })
      }))

    const { listPiAvailableModels } = await import('../pi-models')

    await expect(listPiAvailableModels({ cwd: process.cwd() })).rejects.toThrow('temporary startup failure')
    await expect(listPiAvailableModels({ cwd: process.cwd() })).resolves.toEqual([{
      id: 'openai-codex/gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      reasoning: true,
      reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'],
      contextWindow: 272000,
    }])
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('bypasses a successful cached catalog when refresh is requested', async () => {
    for (const id of ['glm-5.3', 'glm-5.3-flash']) {
      spawn.mockImplementationOnce(() => mockPiProcess((request, proc) => {
        const response = JSON.stringify({
          id: request.id,
          type: 'response',
          command: 'get_available_models',
          success: true,
          data: { models: [{ provider: 'zai', id, name: id, reasoning: true }] },
        }) + '\n'
        queueMicrotask(() => proc.stdout.write(response))
      }))
    }

    const { listPiAvailableModels } = await import('../pi-models')

    await expect(listPiAvailableModels({ cwd: process.cwd() })).resolves.toEqual([
      expect.objectContaining({ id: 'zai/glm-5.3' }),
    ])
    await expect(listPiAvailableModels({ cwd: process.cwd(), forceRefresh: true })).resolves.toEqual([
      expect.objectContaining({ id: 'zai/glm-5.3-flash' }),
    ])
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})
