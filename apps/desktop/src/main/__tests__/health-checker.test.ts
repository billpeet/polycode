/**
 * Characterisation tests for health/checker.ts, written as it moved behind the
 * Runner seam. The module had no tests before; FakeRunner is what made it
 * testable, so the test lands with the conversion rather than after it.
 *
 * What matters here is transport selection and the exact probe text — a check
 * that runs the right command against the wrong machine still reports a healthy
 * CLI, just not the user's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeRunner } from '../driver/runner/fake'
import type { RunResult } from '../driver/runner'

const createRunnerMock = vi.fn()

vi.mock('../driver/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../driver/runner')>()
  return { ...actual, createRunner: (...args: unknown[]) => createRunnerMock(...args) }
})

const SSH = { host: 'example.test', user: 'alice' }
const WSL = { distro: 'Ubuntu' }

/** Fresh module per test — checker.ts caches results in module-level state. */
async function loadChecker(): Promise<typeof import('../health/checker')> {
  vi.resetModules()
  return import('../health/checker')
}

function fakeFor(type: 'local' | 'wsl' | 'ssh', result: Partial<RunResult> = {}): FakeRunner {
  const runner = new FakeRunner(type)
  runner.queueResult(result)
  createRunnerMock.mockReturnValue(runner)
  return runner
}

beforeEach(() => {
  createRunnerMock.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) })))
})

describe('checkCliHealth — transport selection', () => {
  it('builds an ssh Runner and probes with a script when the location is ssh', async () => {
    const runner = fakeFor('ssh', { stdout: '1.2.3\n' })
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('claude-code', 'ssh', SSH, null)

    expect(createRunnerMock).toHaveBeenCalledWith({ ssh: SSH })
    expect(runner.runScriptCommands).toHaveLength(1)
    expect(runner.runCommands).toHaveLength(0)
    expect(result.currentVersion).toBe('1.2.3')
  })

  it('builds a wsl Runner when the location is wsl', async () => {
    const runner = fakeFor('wsl', { stdout: '1.2.3\n' })
    const { checkCliHealth } = await loadChecker()

    await checkCliHealth('claude-code', 'wsl', null, WSL)

    expect(createRunnerMock).toHaveBeenCalledWith({ wsl: WSL })
    expect(runner.runScriptCommands).toHaveLength(1)
  })

  it('falls back to local when the connection type claims ssh but no config is present', async () => {
    const runner = fakeFor('local', { stdout: '1.2.3\n' })
    const { checkCliHealth } = await loadChecker()

    await checkCliHealth('claude-code', 'ssh', null, null)

    expect(createRunnerMock).toHaveBeenCalledWith({})
    expect(runner.runScriptCommands).toHaveLength(0)
    expect(runner.runCommands).toHaveLength(1)
  })

  it('uses argv rather than a script locally, so no shell parses the binary name', async () => {
    const runner = fakeFor('local', { stdout: '1.2.3\n' })
    const { checkCliHealth } = await loadChecker()

    await checkCliHealth('codex', 'local', null, null)

    expect(runner.runCommands[0]).toMatchObject({ args: ['--version'], timeoutMs: 10000 })
    expect(runner.runCommands[0].binary).toBe('codex')
  })

  it('asks cursor for `about --format json`, not --version', async () => {
    const runner = fakeFor('local', { stdout: '2026.04.09' })
    const { checkCliHealth } = await loadChecker()

    await checkCliHealth('cursor', 'local', null, null)

    expect(runner.runCommands[0].args).toEqual(['about', '--format', 'json'])
  })

  it('probes grok with a plain --version', async () => {
    const runner = fakeFor('local', { stdout: 'grok 0.3.1\n' })
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('grok', 'local', null, null)

    expect(runner.runCommands[0]).toMatchObject({ binary: 'grok', args: ['--version'] })
    expect(result.currentVersion).toBe('0.3.1')
    expect(result.installed).toBe(true)
  })
})

describe('checkCliHealth — remote probe contents', () => {
  it('carries the codex binary resolver into the remote script', async () => {
    const runner = fakeFor('ssh', { stdout: '1.2.3' })
    const { checkCliHealth } = await loadChecker()

    await checkCliHealth('codex', 'ssh', SSH, null)

    const { script } = runner.runScriptCommands[0]
    expect(script).toContain('CODEX_BIN')
    expect(script).toContain('/mnt/c/*')
  })

  it('deliberately sends no workDir, so the probe does not cd anywhere', async () => {
    const runner = fakeFor('wsl', { stdout: '1.2.3' })
    const { checkCliHealth } = await loadChecker()

    await checkCliHealth('claude-code', 'wsl', null, WSL)

    expect(runner.runScriptCommands[0].workDir).toBeUndefined()
  })
})

describe('checkCliHealth — result shaping', () => {
  it('reports an unsupported persisted provider instead of throwing', async () => {
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('removed-provider', 'local', null, null)

    expect(result).toMatchObject({
      installed: false,
      currentVersion: null,
      latestVersion: null,
      upToDate: null,
      error: 'Unsupported provider: removed-provider',
    })
    expect(createRunnerMock).not.toHaveBeenCalled()
  })

  it('migrates the legacy claude provider id at the health boundary', async () => {
    const runner = fakeFor('local', { stdout: '1.2.3\n' })
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('claude', 'local', null, null)

    expect(runner.runCommands[0].binary).toMatch(/claude(?:\.exe)?$/)
    expect(runner.runCommands[0].args).toEqual(['--version'])
    expect(result.currentVersion).toBe('1.2.3')
  })

  it('reads a version out of stderr, which is where several CLIs print it', async () => {
    fakeFor('local', { stdout: '', stderr: 'codex 4.5.6\n', exitCode: 1 })
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('codex', 'local', null, null)

    expect(result.currentVersion).toBe('4.5.6')
    expect(result.installed).toBe(true)
  })

  it('reports not-installed when the probe produces nothing and fails', async () => {
    const runner = new FakeRunner('local')
    runner.queueResult({ exitCode: null })
    runner.queueResult({ exitCode: null }) // the module retries once
    createRunnerMock.mockReturnValue(runner)
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('codex', 'local', null, null)

    expect(result.installed).toBe(false)
    expect(result.currentVersion).toBeNull()
  })

  it('uses a presence check rather than a version check for pi', async () => {
    const runner = fakeFor('local', { exitCode: 0 })
    const { checkCliHealth } = await loadChecker()

    const result = await checkCliHealth('pi', 'local', null, null)

    expect(result.installed).toBe(true)
    expect(result.currentVersion).toBeNull()
    const binary = runner.runCommands[0].binary
    expect(binary === 'where' || binary === 'sh').toBe(true)
  })
})

describe('updateCli', () => {
  it('refuses an unsupported persisted provider without invoking a runner', async () => {
    const { updateCli } = await loadChecker()

    await expect(updateCli('removed-provider', 'local', null, null)).resolves.toEqual({
      success: false,
      output: 'Unsupported provider: removed-provider',
    })
    expect(createRunnerMock).not.toHaveBeenCalled()
  })

  it('runs claude-code through its own updater locally', async () => {
    const runner = fakeFor('local', { stdout: 'updated', exitCode: 0 })
    const { updateCli } = await loadChecker()

    const result = await updateCli('claude-code', 'local', null, null)

    expect(runner.runCommands[0]).toMatchObject({ binary: 'claude', args: ['update'] })
    expect(result.success).toBe(true)
    expect(result.output).toBe('updated')
  })

  it('falls back to npm for providers with no own updater', async () => {
    const runner = fakeFor('local', { exitCode: 0 })
    const { updateCli } = await loadChecker()

    await updateCli('codex', 'local', null, null)

    expect(runner.runCommands[0]).toMatchObject({
      binary: 'npm',
      args: ['install', '-g', '@openai/codex@latest'],
    })
  })

  it('runs grok through its own updater — it installs from x.ai/cli, not npm', async () => {
    const runner = fakeFor('local', { stdout: 'updated', exitCode: 0 })
    const { updateCli } = await loadChecker()

    const result = await updateCli('grok', 'local', null, null)

    expect(runner.runCommands[0]).toMatchObject({ binary: 'grok', args: ['update'] })
    expect(result.success).toBe(true)
  })

  it('bootstraps HOME and the node managers before updating over ssh', async () => {
    const runner = fakeFor('ssh', { exitCode: 0 })
    const { updateCli } = await loadChecker()

    await updateCli('codex', 'ssh', SSH, null)

    const { script, timeoutMs } = runner.runScriptCommands[0]
    expect(script).toContain('export HOME=')
    expect(script).toContain('npm install -g @openai/codex@latest')
    expect(timeoutMs).toBe(120000)
  })

  it('reports failure on a non-zero exit', async () => {
    fakeFor('local', { stderr: 'EACCES', exitCode: 1 })
    const { updateCli } = await loadChecker()

    const result = await updateCli('codex', 'local', null, null)

    expect(result.success).toBe(false)
    expect(result.output).toContain('EACCES')
  })
})
