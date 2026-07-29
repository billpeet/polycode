import { describe, expect, it, vi } from 'vitest'
import { runRemoteShell } from '../remote-shell'
import { sshExec } from '../ssh'
import { wslExec } from '../wsl'

vi.mock('../ssh', () => ({
  sshExec: vi.fn(async () => 'ssh output'),
}))

vi.mock('../wsl', () => ({
  wslExec: vi.fn(async () => 'wsl output'),
}))

describe('runRemoteShell', () => {
  it('uses SSH when both remote locations are present', async () => {
    const result = await runRemoteShell(
      '/repo',
      'printf hello',
      { host: 'example.test', user: 'alice' },
      { distro: 'Ubuntu' },
    )

    expect(result).toBe('ssh output')
    expect(sshExec).toHaveBeenCalledWith(
      { host: 'example.test', user: 'alice' },
      '/repo',
      'printf hello',
    )
    expect(wslExec).not.toHaveBeenCalled()
  })

  it('uses WSL when it is the remote location', async () => {
    const result = await runRemoteShell('/repo', 'printf hello', null, { distro: 'Ubuntu' })

    expect(result).toBe('wsl output')
    expect(wslExec).toHaveBeenCalledWith({ distro: 'Ubuntu' }, '/repo', 'printf hello')
  })

  it('rejects a local location', () => {
    expect(() => runRemoteShell('/repo', 'printf hello')).toThrow(
      'Remote shell execution requires an SSH or WSL location',
    )
  })
})
