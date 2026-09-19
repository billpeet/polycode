// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import ComposerToolbar from '../ComposerToolbar'
import { client } from '../../../lib/client'

vi.mock('../../../lib/client', () => ({ client: { invoke: vi.fn(async () => []) } }))
vi.mock('../../../lib/prefs', () => ({ getPref: vi.fn(async () => null), setPref: vi.fn() }))
vi.mock('../CliHealthIndicator', () => ({ default: () => null }))
vi.mock('../SubscriptionUsageIndicator', () => ({ default: () => null }))
vi.mock('../BackgroundTerminals', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function browseKimi() {
  const setProviderAndModel = vi.fn()
  render(<ComposerToolbar {...{
    threadId: 'thread-1', currentThread: { id: 'thread-1', provider: 'codex', model: 'gpt-6-astra' },
    availableDistros: [], setProviderAndModel, setModel: vi.fn(), setReasoningLevel: vi.fn(),
    setCodexPersonality: vi.fn(), setCodexReasoningSummary: vi.fn(),
  } as unknown as ComponentProps<typeof ComposerToolbar>} />)
  fireEvent.click(screen.getByTitle(/Model settings/))
  fireEvent.click(screen.getByRole('tab', { name: 'Kimi Code' }))
  return setProviderAndModel
}

it('loads Kimi models when browsing from a Codex thread, then selects the discovered model', async () => {
  vi.mocked(client.invoke).mockImplementation(async (...args) =>
    (args[0] === 'models:kimiAvailable' ? [{ id: 'kimi-test', label: 'Kimi discovered model' }] : []) as never)
  const select = browseKimi()
  expect(await screen.findByRole('option', { name: 'Kimi discovered model' })).toBeTruthy()
  expect(client.invoke).toHaveBeenCalledWith('models:kimiAvailable', 'thread-1')
  expect(select).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Kimi discovered model/ }))
  expect(select).toHaveBeenCalledWith('thread-1', 'kimi-code', 'kimi-test')
})

it('shows discovery failures in the Kimi pane and retries without changing provider', async () => {
  let fail = true
  vi.mocked(client.invoke).mockImplementation(async (...args) => {
    if (args[0] !== 'models:kimiAvailable') return [] as never
    if (fail) throw new Error('Kimi authentication required')
    return [{ id: 'kimi-test', label: 'Kimi discovered model' }] as never
  })
  const select = browseKimi()
  expect(await screen.findByText('Kimi authentication required')).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('option', { name: 'Kimi discovered model' })).toBeTruthy()
  expect(screen.queryByText('Kimi authentication required')).toBeNull()
  expect(select).not.toHaveBeenCalled()
})
