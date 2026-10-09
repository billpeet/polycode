import { isAppShuttingDownError } from '@polycode/shared'
import { isRemoteTransportError } from './remoteErrors'

/** Settle expected teardown and connectivity failures while leaving real background failures observable. */
export async function settleBackgroundIpc<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation
  } catch (error) {
    if (isAppShuttingDownError(error) || isRemoteTransportError(error)) return undefined
    throw error
  }
}
