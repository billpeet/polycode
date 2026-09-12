// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoginResult, SessionCheck } from '../../lib/webClient'

const web = {
  checkSession: vi.fn<() => Promise<SessionCheck>>(),
  login: vi.fn<(token: string) => Promise<LoginResult>>(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  unauthorized: new Set<() => void>(),
  onUnauthorized: vi.fn((listener: () => void) => {
    web.unauthorized.add(listener)
    return () => web.unauthorized.delete(listener)
  }),
}

vi.mock('../../lib/webClient', () => ({ getWebClient: () => web }))
vi.mock('../../App', () => ({ default: () => <div data-testid="app">app</div> }))

import WebRoot from '../WebRoot'

beforeEach(() => {
  web.checkSession.mockReset()
  web.login.mockReset()
  web.connect.mockReset()
  web.disconnect.mockReset()
  web.unauthorized.clear()
})

afterEach(() => cleanup())

describe('WebRoot', () => {
  it('mounts the app straight away when the browser already holds a session', async () => {
    web.checkSession.mockResolvedValue('authenticated')
    render(<WebRoot />)

    expect(await screen.findByTestId('app')).toBeTruthy()
    expect(web.connect).toHaveBeenCalledTimes(1)
  })

  it('asks for the host token, shows a refusal, then mounts the app on success', async () => {
    web.checkSession.mockResolvedValue('unauthenticated')
    web.login
      .mockResolvedValueOnce({ ok: false, error: 'That token was not accepted.' })
      .mockResolvedValueOnce({ ok: true })
    render(<WebRoot />)

    const input = await screen.findByLabelText('Host token')
    fireEvent.change(input, { target: { value: 'wrong' } })
    fireEvent.submit(input.closest('form')!)
    expect((await screen.findByRole('alert')).textContent).toMatch(/not accepted/)
    expect(screen.queryByTestId('app')).toBeNull()

    fireEvent.change(input, { target: { value: 'right' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByTestId('app')).toBeTruthy()
    expect(web.login).toHaveBeenLastCalledWith('right')
    expect(web.connect).toHaveBeenCalledTimes(1)
  })

  it('offers a retry when the host cannot be reached', async () => {
    web.checkSession.mockResolvedValueOnce('unreachable').mockResolvedValueOnce('authenticated')
    render(<WebRoot />)

    fireEvent.click(await screen.findByText('Try again'))

    expect(await screen.findByTestId('app')).toBeTruthy()
    expect(web.checkSession).toHaveBeenCalledTimes(2)
  })

  it('returns to sign-in when the host stops accepting the session', async () => {
    web.checkSession.mockResolvedValue('authenticated')
    render(<WebRoot />)
    await screen.findByTestId('app')

    for (const listener of web.unauthorized) listener()

    await waitFor(() => expect(screen.queryByTestId('app')).toBeNull())
    expect(await screen.findByLabelText('Host token')).toBeTruthy()
    expect(web.disconnect).toHaveBeenCalled()
  })
})
