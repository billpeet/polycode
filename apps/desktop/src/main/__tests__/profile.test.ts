import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachmentDirectoryName, resolveProfile } from '../profile'

describe('app profiles', () => {
  const defaultUserData = resolve('profiles/polycode-electron')
  it('preserves production and separates development database and attachment paths', () => {
    const production = resolveProfile({ isDev: false, defaultUserData })
    const development = resolveProfile({ isDev: true, defaultUserData })
    expect(production.dataPath).toBe(defaultUserData)
    expect(development.dataPath).toBe(`${defaultUserData}-dev`)
    expect(development.productionDatabasePath).toBe(production.productionDatabasePath)
    expect(attachmentDirectoryName(development.dataPath)).not.toBe(attachmentDirectoryName(production.dataPath))
    expect(attachmentDirectoryName(defaultUserData)).toBe(attachmentDirectoryName(`${defaultUserData}/.`))
  })
  it('supports explicit profiles but rejects a development override of production', () => {
    expect(resolveProfile({ isDev: true, defaultUserData, override: 'profiles/test' }).dataPath).toBe(resolve('profiles/test'))
    expect(() => resolveProfile({ isDev: true, defaultUserData, override: defaultUserData })).toThrow('separate')
  })
})
