/**
 * WSL integration tests for CodexDriver.
 * These tests spawn real WSL processes to diagnose PATH and binary resolution.
 *
 * Run with:  bun test src/main/driver/__tests__/codex-wsl.test.ts
 */
import { describe, it, expect } from 'bun:test'

// nvm init alone takes ~5 s; codex exec is a network call — use generous timeouts.
const NVM_TIMEOUT = 15_000
const CODEX_TIMEOUT = 60_000
import { execFileSync, spawnSync } from 'child_process'

const DISTRO = 'Ubuntu'

/** Run a bash command in WSL and return { stdout, stderr, exitCode }. */
function wslBash(cmd: string, loginShell = true, timeout = 60_000) {
  const bashFlag = loginShell ? '-lc' : '-c'
  const result = spawnSync('wsl', ['-d', DISTRO, '--', 'bash', bashFlag, cmd], {
    encoding: 'utf8',
    timeout,
  })
  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    exitCode: result.status ?? -1,
  }
}

// ── Sanity checks ─────────────────────────────────────────────────────────────

describe('WSL availability', () => {
  it('WSL is available and distro exists', () => {
    const result = spawnSync('wsl', ['-d', DISTRO, '--', 'echo', 'ok'], { encoding: 'utf8' })
    expect(result.stdout.trim()).toBe('ok')
    expect(result.status).toBe(0)
  })
})

// ── PATH diagnostics ──────────────────────────────────────────────────────────

describe('bash -lc PATH diagnostics (no .bashrc)', () => {
  it('shows PATH in login shell (may be empty when spawned from Windows)', () => {
    const { stdout } = wslBash('echo $PATH')
    console.log('bash -lc PATH:', stdout)
    // PATH may appear empty due to WSL UTF-16LE encoding quirks — non-fatal
    expect(typeof stdout).toBe('string')
  })

  it('which codex — login shell only', () => {
    const { stdout, exitCode } = wslBash('which codex 2>&1 || echo NOT_FOUND')
    console.log('which codex (login shell):', stdout)
    // Just log — don't assert pass/fail so the test always completes
    expect(typeof stdout).toBe('string')
  })

  it('which node — login shell only', () => {
    const { stdout } = wslBash('which node 2>&1 || echo NOT_FOUND')
    console.log('which node (login shell):', stdout)
    expect(typeof stdout).toBe('string')
  })
})

describe('bash -lc PATH diagnostics (with source ~/.bashrc)', () => {
  it('which codex — after sourcing .bashrc', () => {
    const { stdout } = wslBash('source ~/.bashrc 2>/dev/null; which codex 2>&1 || echo NOT_FOUND')
    console.log('which codex (after .bashrc):', stdout)
    expect(typeof stdout).toBe('string')
  })

  it('which node — after sourcing .bashrc', () => {
    const { stdout } = wslBash('source ~/.bashrc 2>/dev/null; which node 2>&1 || echo NOT_FOUND')
    console.log('which node (after .bashrc):', stdout)
    expect(typeof stdout).toBe('string')
  })

  it('codex --version — after sourcing .bashrc', () => {
    const { stdout, stderr, exitCode } = wslBash('source ~/.bashrc 2>/dev/null; codex --version 2>&1 || echo FAILED')
    console.log('codex --version:', stdout || stderr)
    expect(typeof stdout).toBe('string')
  })
})

// ── .bashrc inspection ────────────────────────────────────────────────────────

describe('.bashrc inspection', () => {
  it('first 30 lines of ~/.bashrc', () => {
    const { stdout } = wslBash('head -30 ~/.bashrc 2>/dev/null || echo NO_BASHRC')
    console.log('~/.bashrc head:\n', stdout)
    expect(typeof stdout).toBe('string')
  })

  it('nvm-related lines in ~/.bashrc', () => {
    const { stdout } = wslBash('grep -n "nvm\\|NVM\\|node\\|npm\\|fnm\\|volta" ~/.bashrc 2>/dev/null || echo NONE')
    console.log('nvm/node lines in .bashrc:', stdout)
    expect(typeof stdout).toBe('string')
  })

  it('PATH-modifying lines in ~/.profile and ~/.bash_profile', () => {
    const { stdout } = wslBash(
      'grep -n "PATH\\|nvm\\|node" ~/.profile ~/.bash_profile 2>/dev/null || echo NONE'
    )
    console.log('PATH lines in .profile/.bash_profile:', stdout)
    expect(typeof stdout).toBe('string')
  })
})

// ── Node version manager direct loading ───────────────────────────────────────

const LOAD_NODE_MANAGERS = [
  '[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"',
  '[ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH"',
  'command -v fnm &>/dev/null && eval "$(fnm env 2>/dev/null)"',
].join('; ')

describe('node version manager direct loading (the actual fix)', () => {
  it('which node — after sourcing nvm directly', () => {
    const { stdout } = wslBash(`${LOAD_NODE_MANAGERS}; which node 2>&1 || echo NOT_FOUND`)
    console.log('which node (after direct nvm load):', stdout)
    expect(stdout).not.toContain('NOT_FOUND')
  }, NVM_TIMEOUT)

  it('which codex — after sourcing nvm directly', () => {
    const { stdout } = wslBash(`${LOAD_NODE_MANAGERS}; which codex 2>&1 || echo NOT_FOUND`)
    console.log('which codex (after direct nvm load):', stdout)
    // Should now resolve to the WSL-native codex, not /mnt/c/...
    expect(stdout).not.toContain('/mnt/c/')
  }, NVM_TIMEOUT)

  it('codex --version — after sourcing nvm directly', () => {
    const { stdout, stderr, exitCode } = wslBash(`${LOAD_NODE_MANAGERS}; codex --version 2>&1`)
    console.log('codex --version (after direct nvm load):', stdout || stderr)
    expect(exitCode).toBe(0)
  }, NVM_TIMEOUT)
})

// ── Minimal codex exec ────────────────────────────────────────────────────────

describe('codex exec --json via WSL spawn', () => {
  it('runs codex exec --json with a trivial prompt', () => {
    const cmd = `${LOAD_NODE_MANAGERS}; codex exec --json --full-auto 'say only the word pong'`
    const { stdout, stderr, exitCode } = wslBash(cmd)
    console.log('exit:', exitCode)
    console.log('stdout:', stdout.slice(0, 500))
    if (stderr) console.log('stderr:', stderr.slice(0, 300))

    expect(typeof exitCode).toBe('number')
    if (exitCode === 0) {
      expect(stdout).toContain('thread.started')
    }
  }, CODEX_TIMEOUT)
})
