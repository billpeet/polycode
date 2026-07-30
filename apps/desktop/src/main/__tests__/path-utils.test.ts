import { describe, expect, it } from 'vitest'
import { windowsPathToWsl } from '../path-utils'

describe('windowsPathToWsl', () => {
  it('converts Windows drive paths to WSL mount paths', () => {
    expect(windowsPathToWsl('C:\\Users\\foo\\bar')).toBe('/mnt/c/Users/foo/bar')
    expect(windowsPathToWsl('D:/repos/polycode')).toBe('/mnt/d/repos/polycode')
  })

  it('leaves WSL paths unchanged', () => {
    expect(windowsPathToWsl('/mnt/c/repos/polycode')).toBe('/mnt/c/repos/polycode')
  })
})
