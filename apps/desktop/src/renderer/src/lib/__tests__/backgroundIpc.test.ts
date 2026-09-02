import { describe, expect, it } from 'vitest'
import { appShuttingDownMessage } from '@polycode/shared'
import { settleBackgroundIpc } from '../backgroundIpc'

describe('background IPC', () => {
  it('settles an expected application-shutdown rejection', async () => {
    const operation = Promise.reject(
      new Error(`Error invoking remote method 'threads:setUnread': Error: ${appShuttingDownMessage()}`),
    )

    await expect(settleBackgroundIpc(operation)).resolves.toBeUndefined()
  })

  it('keeps unexpected failures observable', async () => {
    const operation = Promise.reject(new Error('IPC unavailable'))

    await expect(settleBackgroundIpc(operation)).rejects.toThrow('IPC unavailable')
  })
})
