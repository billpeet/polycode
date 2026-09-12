// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../../types/ipc'
import type { Favourite } from '../../../stores/favourites'
import ModelSelectorMenu from '../ModelSelectorMenu'
import { useFavouritesStore } from '../../../stores/favourites'

vi.mock('../../../lib/prefs', () => ({ getPref: vi.fn(async () => null), setPref: vi.fn(async () => undefined) }))

afterEach(() => {
  cleanup()
  useFavouritesStore.setState({ bySlot: {}, loaded: true })
})

function renderMenu(overrides: {
  modelsLoading?: boolean
  modelsError?: string | null
  onRetryModels?: () => void
  modelOptions?: { id: string; label: string }[]
  onSelectModel?: (model: string) => void
  applyFavourite?: (fav: Favourite) => void
  providerLocked?: boolean
}) {
  const {
    modelOptions = [{ id: 'openai-codex/gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    onSelectModel = vi.fn(),
    applyFavourite = vi.fn(),
    providerLocked = false,
    ...menuOverrides
  } = overrides
  render(
    <ModelSelectorMenu
      isProcessing={false}
      providerLocked={providerLocked}
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
      applyFavourite={applyFavourite}
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

    fireEvent.change(screen.getByRole('combobox', { name: 'Search models' }), { target: { value: 'gemini' } })

    expect(screen.getByRole('option', { name: 'Google: Gemini 3.7 Flash' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'GPT-5.6 Sol' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Google: Gemini 3.7 Flash/ }))
    expect(selectModel).toHaveBeenCalledWith('google/gemini-3.7-flash')
  })

  it('picks the highlighted search result with Enter', () => {
    const selectModel = vi.fn()
    renderMenu({ onSelectModel: selectModel })
    const search = screen.getByRole('combobox', { name: 'Search models' })
    fireEvent.change(search, { target: { value: 'sol' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(selectModel).toHaveBeenCalledWith('openai-codex/gpt-5.6-sol')
  })
})

describe('ModelSelectorMenu provider rail', () => {
  it('opens on the current provider tab and lists its live models', () => {
    renderMenu({})
    expect(screen.getByRole('tab', { name: 'Pi' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: 'GPT-5.6 Sol' })).toBeTruthy()
  })

  it('switches tabs to browse another provider and selects across providers', () => {
    const applyFavourite = vi.fn()
    renderMenu({ applyFavourite })
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    expect(screen.getByRole('option', { name: 'Opus 4.8' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Opus 4.8/ }))
    expect(applyFavourite).toHaveBeenCalledWith({ provider: 'claude-code', model: 'claude-opus-4-8', reasoningLevel: 'off' })
  })

  it("refuses another provider's models once the provider is locked", () => {
    const applyFavourite = vi.fn()
    renderMenu({ applyFavourite, providerLocked: true })
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    const row = screen.getByRole('button', { name: /^GPT-5.5 /}) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(row)
    expect(applyFavourite).not.toHaveBeenCalled()
  })
})

describe('ModelSelectorMenu favourites', () => {
  it('stars a model into the first free slot and shows it on the favourites tab', () => {
    renderMenu({})
    fireEvent.click(screen.getByRole('button', { name: 'Add GPT-5.6 Sol to favourites' }))
    expect(useFavouritesStore.getState().bySlot[1]).toEqual({ provider: 'pi', model: 'openai-codex/gpt-5.6-sol', reasoningLevel: 'off' })

    fireEvent.click(screen.getByRole('tab', { name: 'Favourites' }))
    expect(within(screen.getByRole('listbox')).getByRole('button', { name: /Pi · GPT-5.6 Sol/ })).toBeTruthy()
  })

  it('un-stars a favourited model', () => {
    useFavouritesStore.setState({ bySlot: { 3: { provider: 'pi', model: 'openai-codex/gpt-5.6-sol', reasoningLevel: 'high' } } })
    renderMenu({})
    fireEvent.click(screen.getByRole('button', { name: 'Remove GPT-5.6 Sol from favourites' }))
    expect(useFavouritesStore.getState().bySlot[3]).toBeUndefined()
  })
})
