/**
 * RunNotifier adapter over Electron OS notifications — the only place the
 * Run lifecycle's escalations touch Electron.
 */
import { Notification } from 'electron'
import { RunNotifier } from '../types'

export const electronRunNotifier: RunNotifier = {
  runEscalated(routineName, reason) {
    if (!Notification.isSupported()) return
    new Notification({ title: `Routine needs attention: ${routineName}`, body: reason }).show()
  },

  invalidSchedule(routineName) {
    if (!Notification.isSupported()) return
    new Notification({
      title: `Routine has an invalid schedule: ${routineName}`,
      body: 'The routine will not fire until its schedule is fixed.',
    }).show()
  },
}
