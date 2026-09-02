import { isAppShuttingDownError } from '@polycode/shared'

/** Settle expected teardown cancellation while leaving real background failures observable. */
export async function settleBackgroundIpc<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation
  } catch (error) {
    if (isAppShuttingDownError(error)) return undefined
    throw error
  }
}
