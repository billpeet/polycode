import { isAppShuttingDownError, isRemoteHostBusyError } from '@polycode/shared'
import { isRemoteTransportError } from './remoteErrors'
import { useToastStore } from '../stores/toast'

/** Event boundary for a single command mutation; callers must not retry on failure. */
export async function runCommandAction(operation: () => Promise<void>): Promise<boolean> {
  try {
    await operation()
    return true
  } catch (error) {
    if (isAppShuttingDownError(error)) return false
    const disconnected = isRemoteTransportError(error)
    useToastStore.getState().add({
      type: 'error',
      message: isRemoteHostBusyError(error)
        ? 'Remote host is busy. The command was not started; try again shortly.'
        : disconnected
          ? 'Remote host connection lost. The command may have executed; check its status after reconnecting.'
          : 'Command failed.',
      details: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
