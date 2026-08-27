// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../../types/ipc'
import ModelSelectorMenu from '../ModelSelectorMenu'

afterEach(cleanup)

function renderMenu(overrides: { modelsLoading?: boolean; modelsError?: string | null; onRetryModels?: () => void }) {
  render(
    <ModelSelectorMenu
      isProcessing={false}
      providerLocked={false}
      currentThread={{ provider: 'pi', model: 'openai-codex/gpt-5.6-sol' } as Thread}
      modelOptions={[{ id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol' }]}
      reasoningOptions={['off']}
      currentReasoningLevel="off"
      showReasoningSelector
      contextWindows={[]}
      onSelectProvider={vi.fn()}
      onSelectModel={vi.fn()}
      onSelectReasoning={vi.fn()}
      onSelectCodexSummary={vi.fn()}
      onSelectPersonality={vi.fn()}
      onSelectContextWindow={vi.fn()}
      applyFavourite={vi.fn()}
      {...overrides}
    />
  )
  fireEvent.click(screen.getByTitle(/Model settings/))
}

describe('ModelSelectorMenu model discovery feedback', () => {
  it('shows a loading indicator while models are being discovered', () => {
    renderMenu({ modelsLoading: true })
    expect(screen.getByLabelText('Loading models')).toBeTruthy()
  })

  it('offers a retry after discovery fails', () => {
    const retry = vi.fn()
    renderMenu({ modelsError: 'Pi model discovery failed', onRetryModels: retry })

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(retry).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Retry' }).getAttribute('title')).toBe('Pi model discovery failed')
  })
})
