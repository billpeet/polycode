/**
 * Event watch for the unified ("All") view: one SSE stream per saved host, each event
 * tagged with the host it came from.
 *
 * Deliberately separate from `sseManager`. That manager models the one *active* host —
 * its state drives the single-source connection dot and its events land on the global
 * router, where every listener assumes they describe the active host. Events from other
 * hosts must not reach that router (thread ids are only unique per host), so the watch
 * hands them to its own consumer instead. The active host is watched here too: one more
 * stream is cheaper than teaching two consumers to share one.
 */
import { fetch as expoFetch } from 'expo/fetch'
import { AppState, type AppStateStatus } from 'react-native'
import {
  isUnifiedWatchedChannel,
  RemoteEventStream,
  type EventStreamResponse,
  type UnifiedSourceEvent,
} from '@polycode/shared'
import type { HostConnection } from './client'

export interface WatchTarget extends HostConnection {
  sourceId: string
}


type Listener = (event: UnifiedSourceEvent) => void

class UnifiedWatch {
  private streams = new Map<string, { target: WatchTarget; stream: RemoteEventStream }>()
  private appStateSub: { remove(): void } | null = null
  private listener: Listener = () => undefined
  /** True between the app going to the background and coming back. */
  private paused = AppState.currentState === 'background'

  /** The single consumer of watch events (the unified store). */
  setListener(listener: Listener): void {
    this.listener = listener
  }

  /**
   * Watch exactly `targets`: dial new hosts, redial ones whose credentials changed and
   * drop the rest. An empty list stops the watch.
   */
  sync(targets: WatchTarget[]): void {
    for (const [id, entry] of this.streams) {
      const current = targets.find((target) => target.sourceId === id)
      if (!current || current.baseUrl !== entry.target.baseUrl || current.token !== entry.target.token) {
        entry.stream.stop()
        this.streams.delete(id)
      }
    }
    for (const target of targets) {
      if (this.streams.has(target.sourceId)) continue
      const { sourceId } = target
      const stream = new RemoteEventStream(
        {
          onEvent: (event) => {
            if (isUnifiedWatchedChannel(event.channel)) {
              this.listener({ sourceId, kind: 'event', channel: event.channel, args: event.args })
            }
          },
          onConnected: () => this.listener({ sourceId, kind: 'connection', connected: true }),
          onDisconnected: () => this.listener({ sourceId, kind: 'connection', connected: false }),
        },
        // React Native's global fetch buffers the whole response; only expo/fetch streams.
        { fetchFn: (url, init) => expoFetch(url, init) as unknown as Promise<EventStreamResponse> },
      )
      this.streams.set(sourceId, { target, stream })
      // Not while backgrounded: the foreground handler dials when the app returns.
      if (!this.paused) stream.start(target)
    }

    if (this.streams.size > 0 && !this.appStateSub) {
      this.appStateSub = AppState.addEventListener('change', this.handleAppState)
    }
    if (this.streams.size === 0 && this.appStateSub) {
      this.appStateSub.remove()
      this.appStateSub = null
    }
  }

  private handleAppState = (status: AppStateStatus): void => {
    // Streams silently die when the app backgrounds or the phone locks, so they are
    // torn down on the way out and redialled on return. Each redial reports
    // `connected`, which is the consumer's cue to refetch what it missed.
    //
    // `inactive` is not that: Control Centre, the app switcher and a Face ID prompt all
    // pass through it with the streams still alive, and treating it as a disconnect
    // would re-read every host each time.
    if (status === 'background' && !this.paused) {
      this.paused = true
      for (const { target, stream } of this.streams.values()) {
        stream.stop()
        this.listener({ sourceId: target.sourceId, kind: 'connection', connected: false })
      }
    } else if (status === 'active' && this.paused) {
      this.paused = false
      for (const { target, stream } of this.streams.values()) stream.start(target)
    }
  }
}

export const unifiedWatch = new UnifiedWatch()
