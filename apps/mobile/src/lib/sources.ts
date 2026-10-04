import { useHostsStore } from '@/stores/hosts'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import { useUiStore } from '@/stores/ui'
import { useUnifiedStore } from '@/stores/unified'

/**
 * Make `hostId` the active host: the one the thread screen, the New-thread sheet and
 * every single-host store talk to. Everything those stores hold belongs to the previous
 * host, so it is dropped. A no-op when the host is already active.
 *
 * In the unified ("All") view this is how a Thread on any host gets opened: the view
 * itself spans every host, but a Thread is only ever conducted through the active one.
 */
export function activateHost(hostId: string): void {
  const hosts = useHostsStore.getState()
  if (hosts.activeHostId === hostId) return
  // Anything else would leave the app with no host at all.
  if (!hosts.hosts.some((host) => host.id === hostId)) return
  hosts.setActiveHost(hostId)
  useProjectsStore.getState().clear()
  useThreadsStore.setState({ threadsByProject: {}, queueThreads: [] })
}

/** The top-bar source switcher's choice: every host at once, or one of them. */
export function selectSource(source: 'all' | { hostId: string }): void {
  const unified = useUnifiedStore.getState()
  const all = source === 'all'
  // A Queue filter names a Project of the outgoing source; it means nothing to the next.
  if (unified.enabled !== all || (!all && useHostsStore.getState().activeHostId !== source.hostId)) {
    useUiStore.getState().setQueueFilter('all')
  }
  if (!all) activateHost(source.hostId)
  unified.setEnabled(all)
}
