import { describe, expect, it } from 'vitest'
import {
  APP_SHUTTING_DOWN_CODE,
  appShuttingDownMessage,
  isAppShuttingDownError,
} from './ipc-errors'

describe('application shutdown IPC errors', () => {
  it('recognizes the message after Electron wraps a main-process rejection', () => {
    const error = new Error(
      `Error invoking remote method 'commands:getPid': Error: ${appShuttingDownMessage()}`,
    )

    expect(isAppShuttingDownError(error)).toBe(true)
  })

  it('does not classify an unrelated IPC failure as application shutdown', () => {
    expect(isAppShuttingDownError(new Error('IPC unavailable'))).toBe(false)
    expect(APP_SHUTTING_DOWN_CODE).toBe('APP_SHUTTING_DOWN')
  })
})
