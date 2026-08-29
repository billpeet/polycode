import { describe, expect, it } from 'vitest'
import { featureUsageForChannel } from './feature-usage'

describe('feature usage catalog', () => {
  it('maps explicit user actions to stable product vocabulary', () => {
    expect(featureUsageForChannel('threads:send')).toEqual({ feature: 'turn', action: 'send' })
    expect(featureUsageForChannel('routines:runNow')).toEqual({ feature: 'routine', action: 'run_now' })
    expect(featureUsageForChannel('forge:pr:create')).toEqual({ feature: 'pull_request', action: 'create' })
  })

  it('does not classify reads, polling, or automatic refreshes as usage', () => {
    expect(featureUsageForChannel('git:status')).toBeUndefined()
    expect(featureUsageForChannel('forge:pr:list')).toBeUndefined()
    expect(featureUsageForChannel('messages:list')).toBeUndefined()
    expect(featureUsageForChannel('commands:getStatus')).toBeUndefined()
  })
})
