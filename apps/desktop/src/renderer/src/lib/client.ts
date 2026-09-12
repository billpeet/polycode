import type { ChannelArgs, ChannelResult, LocalChannel } from '@polycode/shared'
import type { WindowApi } from '../types/ipc'
import { WEB_CAPABILITIES, getWebClient } from './webClient'

/**
 * The renderer's one seam onto the process that owns its data.
 *
 * Every request/response call, every push subscription and every fire-and-forget send
 * goes through `client` rather than `window.api`. In Electron that is the preload bridge;
 * in a browser served by a Remote Host it is the HTTP/SSE client in `webClient.ts`.
 * Renderer code never learns which one it has — it asks `client.capabilities` when a
 * feature only exists on one side of the seam.
 *
 * Resolution is per call rather than at module load. Tests stub `window.api` after import
 * and swap it between cases, and there is no cost to a property read per invoke.
 */

export type ClientKind = 'electron' | 'web'

/**
 * Features that exist only where a real desktop is attached. Each flag names a group of
 * `{ remote: false }` channels or an Electron-only surface; renderer code gates UI on the
 * flag, never on `kind`, so a capability can move across the seam without a sweep.
 */
export interface ClientCapabilities {
  /** TitleBar minimise/maximise/close and the drag region (`window:*`). */
  windowControls: boolean
  /** Open in Explorer/VS Code/terminal, reveal, open externally, open logs folder (`shell:*`). */
  shell: boolean
  /** Native file and directory pickers (`dialog:*`). */
  nativeDialogs: boolean
  /** The internal `<webview>` browser panel (`browser:*`). */
  browserPanel: boolean
  /** In-app updater (`update:*`). */
  updates: boolean
  /** Remote-host management and the host switcher (`remote:*`). */
  remoteHosts: boolean
  /** Routine management (`routines:*`). */
  routines: boolean
  /** Inbound webhook configuration (`webhook:*`). */
  webhook: boolean
}

export interface Client extends WindowApi {
  kind: ClientKind
  capabilities: ClientCapabilities
}

const ELECTRON_CAPABILITIES: ClientCapabilities = Object.freeze({
  windowControls: true,
  shell: true,
  nativeDialogs: true,
  browserPanel: true,
  updates: true,
  remoteHosts: true,
  routines: true,
  webhook: true,
})

function preloadApi(): WindowApi | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

/** Bind a `Client` to a specific preload bridge. Exposed for tests. */
export function createElectronClient(api: WindowApi): Client {
  return {
    kind: 'electron',
    capabilities: ELECTRON_CAPABILITIES,
    systemLocale: api.systemLocale,
    invoke: (channel, ...args) => api.invoke(channel, ...args),
    on: (channel, callback) => api.on(channel, callback),
    send: (channel, ...args) => api.send(channel, ...args),
    onSlowInvoke: (callback) => api.onSlowInvoke(callback),
  }
}

export const client: Client = {
  get kind(): ClientKind {
    return preloadApi() ? 'electron' : 'web'
  },
  get capabilities(): ClientCapabilities {
    return preloadApi() ? ELECTRON_CAPABILITIES : WEB_CAPABILITIES
  },
  get systemLocale(): string | undefined {
    return preloadApi()?.systemLocale
  },
  invoke<C extends LocalChannel>(channel: C, ...args: ChannelArgs<C>): Promise<ChannelResult<C>> {
    const api = preloadApi()
    return api ? api.invoke(channel, ...args) : getWebClient().invoke(channel, ...args)
  },
  on(channel, callback) {
    const api = preloadApi()
    return api ? api.on(channel, callback) : getWebClient().on(channel, callback)
  },
  send(channel, ...args) {
    const api = preloadApi()
    if (api) api.send(channel, ...args)
    else getWebClient().send(channel, ...args)
  },
  onSlowInvoke(callback) {
    const api = preloadApi()
    return api ? api.onSlowInvoke(callback) : getWebClient().onSlowInvoke(callback)
  },
}
