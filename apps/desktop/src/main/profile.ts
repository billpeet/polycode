import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { AppProfile } from '@polycode/shared'

export function resolveProfile(options: {
  isDev: boolean
  defaultUserData: string
  override?: string
}): AppProfile {
  const productionPath = options.defaultUserData
  const dataPath = resolve(options.override || (options.isDev ? `${productionPath}-dev` : productionPath))
  const samePath = process.platform === 'win32'
    ? dataPath.toLowerCase() === resolve(productionPath).toLowerCase()
    : dataPath === resolve(productionPath)
  if (options.isDev && samePath) throw new Error('Development must use a separate data directory from production.')
  return { isDevelopment: options.isDev, dataPath, productionDatabasePath: join(productionPath, 'polycode.db') }
}

export function attachmentDirectoryName(dataPath: string): string {
  const normalized = process.platform === 'win32' ? resolve(dataPath).toLowerCase() : resolve(dataPath)
  return `polycode-attachments-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
}

let profile: AppProfile | undefined

export function setAppProfile(value: AppProfile): void { profile = value }

export function getAppProfile(): AppProfile {
  if (!profile) throw new Error('App profile has not been initialized')
  return profile
}
