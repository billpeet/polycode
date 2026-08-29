import { count } from './observability'

export interface FeatureUsage {
  feature: string
  action: string
}

// Only explicit, intent-bearing commands belong here. Read/poll/refresh channels
// are deliberately absent so operational activity cannot inflate product usage.
const FEATURE_USAGE_BY_CHANNEL: Readonly<Record<string, FeatureUsage>> = {
  'threads:create': { feature: 'thread', action: 'create' },
  'threads:send': { feature: 'turn', action: 'send' },
  'threads:snooze': { feature: 'thread', action: 'snooze' },
  'threads:executePlanInNewContext': { feature: 'plan', action: 'execute_new_context' },
  'sessions:switch': { feature: 'session', action: 'switch' },
  'commands:create': { feature: 'project_command', action: 'create' },
  'commands:start': { feature: 'project_command', action: 'start' },
  'commands:restart': { feature: 'project_command', action: 'restart' },
  'routines:create': { feature: 'routine', action: 'create' },
  'routines:runNow': { feature: 'routine', action: 'run_now' },
  'terminal:spawn': { feature: 'integrated_terminal', action: 'open' },
  'browser:prepareSession': { feature: 'internal_browser', action: 'open' },
  'claude-history:import': { feature: 'history_import', action: 'import' },
  'git:commit': { feature: 'git', action: 'commit' },
  'git:amendCommit': { feature: 'git', action: 'amend_commit' },
  'git:push': { feature: 'git', action: 'push' },
  'git:publishBranch': { feature: 'git', action: 'publish_branch' },
  'git:pull': { feature: 'git', action: 'pull' },
  'git:checkout': { feature: 'git', action: 'checkout' },
  'git:createBranch': { feature: 'git', action: 'create_branch' },
  'git:merge': { feature: 'git', action: 'merge' },
  'git:stashCreate': { feature: 'git', action: 'stash' },
  'forge:pr:create': { feature: 'pull_request', action: 'create' },
  'forge:pr:checkout': { feature: 'pull_request', action: 'checkout' },
}

export function featureUsageForChannel(channel: string): FeatureUsage | undefined {
  return FEATURE_USAGE_BY_CHANNEL[channel]
}

export function recordFeatureUsage(channel: string, outcome: 'ok' | 'error'): void {
  const usage = featureUsageForChannel(channel)
  if (!usage) return
  count('polycode.feature.usage', { ...usage, outcome })
}
