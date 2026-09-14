import { BrowserWindow } from 'electron'
import { REMOTE_CHANNELS, isRemoteChannel } from '@polycode/shared'
import { invokeChannelHandler, isMigratedChannel } from '../ipc/channel-handlers'
import { runAppOperation } from '../app-lifecycle'
import type { RunLifecycle } from '../runs/lifecycle'

export const CONTROL_RPC_CHANNELS: ReadonlySet<string> = new Set(REMOTE_CHANNELS)

/**
 * What this desktop lends a remote caller: the window whose renderer mirrors the
 * caller's actions, and the Run lifecycle that `routines:*` drive. Both are bound once
 * at the composition root and handed to the server that owns the transport.
 */
export interface ControlRpcHost {
  window: BrowserWindow
  runLifecycle: RunLifecycle
}

export async function handleControlRpc(host: ControlRpcHost, channel: string, args: unknown[]): Promise<unknown> {
  return runAppOperation(() => handleControlRpcWhileRunning(host, channel, args),
    isRemoteChannel(channel) ? channel : 'unsupported')
}

async function handleControlRpcWhileRunning(host: ControlRpcHost, channel: string, args: unknown[]): Promise<unknown> {
  // Channels folded into the typed handler map. The `isRemoteChannel` guard derives
  // reachability from the registry rather than from which switch happens to have a
  // case, so a local-only channel stays unreachable from this transport even once it
  // is folded.
  if (isMigratedChannel(channel) && isRemoteChannel(channel)) {
    return invokeChannelHandler(channel, { window: host.window, origin: 'remote', runLifecycle: host.runLifecycle }, args)
  }

  // Every channel lives in `ipc/channel-handlers.ts`, typed against ChannelContract.
  // Reaching here means the channel is either unknown or `{ remote: false }` -- the guard
  // above admits only what the registry says a remote caller may invoke.
  throw new Error(`Unsupported remote control channel: ${channel}`)
}
