import { BrowserWindow } from 'electron'
import { REMOTE_CHANNELS, isRemoteChannel } from '@polycode/shared'
import { invokeChannelHandler, isMigratedChannel } from '../ipc/channel-handlers'

export const CONTROL_RPC_CHANNELS: ReadonlySet<string> = new Set(REMOTE_CHANNELS)

export async function handleControlRpc(window: BrowserWindow, channel: string, args: unknown[]): Promise<unknown> {
  // Channels folded into the typed handler map. The `isRemoteChannel` guard derives
  // reachability from the registry rather than from which switch happens to have a
  // case, so a local-only channel stays unreachable from this transport even once it
  // is folded.
  if (isMigratedChannel(channel) && isRemoteChannel(channel)) {
    return invokeChannelHandler(channel, { window, origin: 'remote' }, args)
  }

  // The switch this file used to be is gone: every channel it dispatched now lives in
  // `ipc/channel-handlers.ts`, typed against ChannelContract. The nine `remote:*` channels
  // that are still unfolded are registered in `remote/client.ts` and are `local`-only, so
  // they were never reachable from here either.
  throw new Error(`Unsupported remote control channel: ${channel}`)
}
