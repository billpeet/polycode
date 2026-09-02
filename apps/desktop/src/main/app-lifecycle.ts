import { APP_SHUTTING_DOWN_CODE, appShuttingDownMessage } from '@polycode/shared'

export type AppLifecycleState = 'running' | 'closing' | 'closed'

export class AppShuttingDownError extends Error {
  readonly code = APP_SHUTTING_DOWN_CODE

  constructor() {
    super(appShuttingDownMessage())
    this.name = 'AppShuttingDownError'
  }
}

let state: AppLifecycleState = 'running'
let activeOperations = 0
const idleWaiters = new Set<() => void>()

export function getAppLifecycleState(): AppLifecycleState {
  return state
}

export function beginAppShutdown(): boolean {
  if (state !== 'running') return false
  state = 'closing'
  return true
}

export function finishAppShutdown(): void {
  state = 'closed'
}

export function assertAppRunning(): void {
  if (state !== 'running') throw new AppShuttingDownError()
}

export async function runAppOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  assertAppRunning()
  activeOperations += 1
  try {
    return await operation()
  } finally {
    activeOperations -= 1
    if (activeOperations === 0) {
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }
  }
}

export function waitForAppOperations(): Promise<void> {
  if (activeOperations === 0) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.add(resolve))
}

export interface ShutdownSteps {
  stopProducers(): void
  awaitProducers(): Promise<unknown>
  closeDatabase(): void
  finish(): void
}

/** Stop every source of asynchronous work before closing the database it uses. */
export async function shutdownApp(steps: ShutdownSteps): Promise<void> {
  if (!beginAppShutdown()) return

  try {
    steps.stopProducers()
    await steps.awaitProducers()
  } finally {
    try {
      steps.closeDatabase()
    } finally {
      finishAppShutdown()
      steps.finish()
    }
  }
}

/** Test-only reset for this process-wide lifecycle singleton. */
export function resetAppLifecycleForTest(): void {
  state = 'running'
  activeOperations = 0
  idleWaiters.clear()
}
