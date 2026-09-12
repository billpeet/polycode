import type { SubscriptionUsageSnapshot } from '../shared/types'
import { ClaudeDriver } from './driver/claude'
import { CodexDriver } from './driver/codex'

/** Read account quota without tying it to the currently selected execution harness. */
export async function getCodexSubscriptionUsage(workingDir: string): Promise<SubscriptionUsageSnapshot> {
  const driver = new CodexDriver({ workingDir, threadId: 'subscription-usage' })
  try {
    return await driver.getSubscriptionUsage()
  } finally {
    driver.forceStop()
  }
}

/** Read account quota without tying it to the currently selected execution harness. */
export async function getClaudeSubscriptionUsage(workingDir: string): Promise<SubscriptionUsageSnapshot> {
  const driver = new ClaudeDriver({ workingDir, threadId: 'subscription-usage' })
  try {
    return await driver.getSubscriptionUsage()
  } finally {
    driver.forceStop()
  }
}
