import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
const setSetting = vi.fn((key: string, value: string) => {
  settings.set(key, value)
})

vi.mock('../db/queries', () => ({
  getSetting: (key: string) => settings.get(key),
  setSetting,
}))

const { readWebhookConfig, saveWebhookConfig } = await import('../webhook/config')

beforeEach(() => {
  settings.clear()
  setSetting.mockClear()
})

describe('readWebhookConfig', () => {
  it('generates and persists a token on first use', () => {
    const config = readWebhookConfig()

    expect(config).toMatchObject({ enabled: false, port: 3284 })
    expect(config.token).toMatch(/^[0-9a-f]{48}$/)
    expect(settings.get('webhook:token')).toBe(config.token)
  })

  it('reuses an existing token', () => {
    settings.set('webhook:token', ' existing-token ')

    expect(readWebhookConfig().token).toBe('existing-token')
    expect(setSetting).not.toHaveBeenCalledWith('webhook:token', expect.anything())
  })

  it('falls back from an invalid stored port', () => {
    settings.set('webhook:port', 'not-a-port')

    expect(readWebhookConfig().port).toBe(3284)
  })
})

describe('saveWebhookConfig', () => {
  it('replaces an empty token before persisting and returning the config', () => {
    const saved = saveWebhookConfig({ enabled: true, port: 9000, token: '  ' })

    expect(saved.token).toMatch(/^[0-9a-f]{48}$/)
    expect(settings.get('webhook:token')).toBe(saved.token)
    expect(settings.get('webhook:enabled')).toBe('true')
    expect(settings.get('webhook:port')).toBe('9000')
  })
})
