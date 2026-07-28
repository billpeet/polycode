// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import UiErrorBoundary from '../UiErrorBoundary'

function BrokenEntry(): ReactNode {
  throw new Error('malformed markdown')
}

describe('UiErrorBoundary', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('contains a failed transcript entry without removing its siblings', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <>
        <div>First message</div>
        <UiErrorBoundary context="Transcript entry" variant="entry">
          <BrokenEntry />
        </UiErrorBoundary>
        <div>Third message</div>
      </>
    )

    expect(screen.getByText('First message')).toBeTruthy()
    expect(screen.getByText('This entry could not be displayed.')).toBeTruthy()
    expect(screen.getByText('Third message')).toBeTruthy()
  })

  it('recovers automatically when its reset keys change', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const view = render(
      <UiErrorBoundary context="Transcript entry" variant="entry" resetKeys={['old-content']}>
        <BrokenEntry />
      </UiErrorBoundary>
    )

    expect(view.getByText('This entry could not be displayed.')).toBeTruthy()

    view.rerender(
      <UiErrorBoundary context="Transcript entry" variant="entry" resetKeys={['new-content']}>
        <div>Updated message</div>
      </UiErrorBoundary>
    )

    expect(view.getByText('Updated message')).toBeTruthy()
  })

  it('offers an escape action at the root', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onEscape = vi.fn()

    render(
      <UiErrorBoundary context="PolyCode" variant="root" onEscape={onEscape}>
        <BrokenEntry />
      </UiErrorBoundary>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Return to navigation' }))
    expect(onEscape).toHaveBeenCalledOnce()
  })
})
