// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../../types/ipc'
import ModelSelectorMenu from '../ModelSelectorMenu'

afterEach(cleanup)

function renderMenu(overrides: {
  modelsLoading?: boolean
  modelsError?: string | null
  onRetryModels?: () => void
  modelOptions?: { id: string; label: string }[]
  onSelectModel?: (model: string) => void
}) {
  const {
    modelOptions = [{ id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    onSelectModel = vi.fn(),
    ...menuOverrides
  } = overrides
  render(
    <ModelSelectorMenu
      isProcessing={false}
      providerLocked={false}
      currentThread={{ provider: 'pi', model: 'openai-codex/gpt-5.6-sol' } as Thread}
      modelOptions={modelOptions}
      reasoningOptions={['off']}
      currentReasoningLevel="off"
      showReasoningSelector
      contextWindows={[]}
      onSelectProvider={vi.fn()}
      onSelectModel={onSelectModel}
      onSelectReasoning={vi.fn()}
      onSelectCodexSummary={vi.fn()}
      onSelectPersonality={vi.fn()}
      onSelectContextWindow={vi.fn()}
      applyFavourite={vi.fn()}
      {...menuOverrides}
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

  it('offers a cache-bypassing refresh after discovery succeeds', () => {
    const refresh = vi.fn()
    renderMenu({ onRetryModels: refresh })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(refresh).toHaveBeenCalledOnce()
  })

  it('filters models by label or id and selects a result', () => {
    const selectModel = vi.fn()
    renderMenu({
      onSelectModel: selectModel,
      modelOptions: [
        { id: 'google/gemini-3.7-flash', label: 'Google: Gemini 3.7 Flash' },
        { id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
        { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
      ],
    })

    fireEvent.click(screen.getByRole('combobox', { name: 'Select model' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Search models' }), { target: { value: 'gemini' } })

    expect(screen.getByRole('option', { name: 'Google: Gemini 3.7 Flash' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'GPT-5.6 Sol' })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: 'Google: Gemini 3.7 Flash' }))
    expect(selectModel).toHaveBeenCalledWith('google/gemini-3.7-flash')
  })
})
