// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function renderToolbar(provider: string, model: string) {
  render(<ComposerToolbar {...{
    threadId: 'thread-1', currentThread: { id: 'thread-1', provider, model },
    availableDistros: [], setProviderAndModel: vi.fn(), setModel: vi.fn(), setReasoningLevel: vi.fn(),
    setCodexPersonality: vi.fn(), setCodexReasoningSummary: vi.fn(),
  } as unknown as ComponentProps<typeof ComposerToolbar>} />)
  fireEvent.click(screen.getByTitle(/Model settings/))
}

it('discovers the live catalogue of a provider browsed from another provider\'s thread', async () => {
  vi.mocked(client.invoke).mockImplementation(async (...args) =>
    (args[0] === 'models:opencodeAvailable' ? [{ id: 'acct/model', label: 'Account model' }] : []) as never)
  renderToolbar('claude-code', 'opus')
  fireEvent.click(screen.getByRole('tab', { name: 'OpenCode' }))
  expect(await screen.findByRole('option', { name: 'Account model' })).toBeTruthy()
  expect(client.invoke).toHaveBeenCalledWith('models:opencodeAvailable', 'thread-1', false)
})

it('refresh bypasses the main-process cache for the browsed provider', async () => {
  let models = [{ id: 'gpt-old', label: 'Old Codex model' }]
  vi.mocked(client.invoke).mockImplementation(async (...args) =>
    (args[0] === 'models:codexAvailable' ? models : []) as never)
  renderToolbar('codex', 'gpt-old')
  expect(await screen.findByRole('option', { name: /Old Codex model/ })).toBeTruthy()
  models = [{ id: 'gpt-new', label: 'New Codex model' }]
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
  expect(await screen.findByRole('option', { name: /New Codex model/ })).toBeTruthy()
  await waitFor(() => expect(client.invoke).toHaveBeenCalledWith('models:codexAvailable', 'thread-1', true))
})
