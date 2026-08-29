import { BrowserWindow } from 'electron'
import { REMOTE_CHANNELS, isRemoteChannel } from '@polycode/shared'
import { invokeChannelHandler, isMigratedChannel } from '../ipc/channel-handlers'
import { runAppOperation } from '../app-lifecycle'

export const CONTROL_RPC_CHANNELS: ReadonlySet<string> = new Set(REMOTE_CHANNELS)

export async function handleControlRpc(window: BrowserWindow, channel: string, args: unknown[]): Promise<unknown> {
  return runAppOperation(() => handleControlRpcWhileRunning(window, channel, args))
}

async function handleControlRpcWhileRunning(window: BrowserWindow, channel: string, args: unknown[]): Promise<unknown> {
  // Channels folded into the typed handler map. The `isRemoteChannel` guard derives
  // reachability from the registry rather than from which switch happens to have a
  // case, so a local-only channel stays unreachable from this transport even once it
  // is folded.
  if (isMigratedChannel(channel) && isRemoteChannel(channel)) {
    return invokeChannelHandler(channel, { window, origin: 'remote' }, args)
  }

  // The switch this file used to be is gone: all 207 channels now live in
  // `ipc/channel-handlers.ts`, typed against ChannelContract. Reaching here means the
  // channel is either unknown or `{ remote: false }` -- the guard above admits only what
  // the registry says a remote caller may invoke.
  throw new Error(`Unsupported remote control channel: ${channel}`)
}
