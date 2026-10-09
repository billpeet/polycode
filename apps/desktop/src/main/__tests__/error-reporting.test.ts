import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  init: vi.fn(),
  getVersion: vi.fn(() => '1.2.3'),
}))

vi.mock('electron', () => ({ app: { getVersion: H.getVersion } }))
vi.mock('@sentry/electron/main', () => ({ init: H.init }))

describe('main-process error reporting', () => {
  let npmPackageVersion: string | undefined

  beforeEach(() => {
    npmPackageVersion = process.env.npm_package_version
    H.init.mockReset()
  })

  afterEach(() => {
    if (npmPackageVersion === undefined) delete process.env.npm_package_version
    else process.env.npm_package_version = npmPackageVersion
  })

  // An installed build runs without a package manager, so npm's environment is absent.
  it('reports the packaged app version as the release when npm_package_version is absent', async () => {
    delete process.env.npm_package_version
    const { initMainErrorReporting } = await import('../error-reporting')

    initMainErrorReporting()

    expect(H.init).toHaveBeenCalledWith(expect.objectContaining({ release: 'polycode@1.2.3' }))
  })

  it('ignores npm_package_version when it disagrees with the packaged version', async () => {
    process.env.npm_package_version = '0.0.0'
    const { initMainErrorReporting } = await import('../error-reporting')

    initMainErrorReporting()

    expect(H.init).toHaveBeenCalledWith(expect.objectContaining({ release: 'polycode@1.2.3' }))
  })

  it('installs the native crash correlation hook', async () => {
    const { initMainErrorReporting } = await import('../error-reporting')
    const beforeSend = vi.fn(async (event) => event)
    initMainErrorReporting(beforeSend)
    expect(H.init).toHaveBeenCalledWith(expect.objectContaining({ beforeSend }))
  })
})
