import { isAppShuttingDownError } from '@polycode/shared'
import { isRemoteTransportError } from './remoteErrors'

/** Settle expected teardown and connectivity failures in fire-and-forget calls. */
export async function settleBackgroundIpc<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation
  } catch (error) {
    if (isAppShuttingDownError(error) || isRemoteTransportError(error)) return undefined
    throw error
  }
}
