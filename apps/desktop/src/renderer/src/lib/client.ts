import type { ChannelArgs, ChannelResult, LocalChannel } from '@polycode/shared'
import type { WindowApi } from '../types/ipc'

/**
 * The renderer's one seam onto the process that owns its data.
 *
 * Every request/response call, every push subscription and every fire-and-forget send
 * goes through `client` rather than `window.api`. In Electron that is the preload bridge;
 * in a browser served by a Remote Host it will be an HTTP/SSE implementation of the same
 * interface (see docs/web-client-plan.md). Renderer code never learns which one it has —
 * it asks `client.capabilities` when a feature only exists on one side of the seam.
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
  /** Open in Explorer/VS Code/terminal, reveal, copy path, open logs folder (`shell:*`). */
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
})

/** A browser has none of the desktop-only surfaces until the web client lands. */
const WEB_CAPABILITIES: ClientCapabilities = Object.freeze({
  windowControls: false,
  shell: false,
  nativeDialogs: false,
  browserPanel: false,
  updates: false,
  remoteHosts: false,
  routines: false,
})

function preloadApi(): WindowApi | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

function requirePreloadApi(): WindowApi {
  const api = preloadApi()
  if (!api) {
    throw new Error(
      'No PolyCode client is available: window.api is missing and no web client is installed',
    )
  }
  return api
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
    return requirePreloadApi().invoke(channel, ...args)
  },
  on(channel, callback) {
    return requirePreloadApi().on(channel, callback)
  },
  send(channel, ...args) {
    requirePreloadApi().send(channel, ...args)
  },
  onSlowInvoke(callback) {
    return requirePreloadApi().onSlowInvoke(callback)
  },
}
