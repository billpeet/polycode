/**
 * Schedule parsing — pure. The RunStore adapter parses every Routine's
 * schedule through here so the lifecycle only ever sees a ParsedSchedule;
 * invalid input becomes a visible `invalid` value, never a silent skip.
 */
import { Routine } from '../../shared/types'
import { parseCron } from './cron'
import { ParsedSchedule } from './types'

export function parseSchedule(routine: Pick<Routine, 'trigger_type' | 'schedule'>): ParsedSchedule {
  switch (routine.trigger_type) {
    case 'manual':
      return { kind: 'manual' }
    case 'cron':
      return routine.schedule !== null && parseCron(routine.schedule) !== null
        ? { kind: 'cron', expr: routine.schedule }
        : { kind: 'invalid', raw: routine.schedule }
    case 'once': {
      const ms = routine.schedule === null ? NaN : Date.parse(routine.schedule)
      return Number.isNaN(ms) ? { kind: 'invalid', raw: routine.schedule } : { kind: 'once', at: new Date(ms) }
    }
  }
}
