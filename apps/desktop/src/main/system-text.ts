import { randomUUID } from 'crypto'
import { promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import type { SshConfig, WslConfig } from '../shared/types'
import { simpleQuery } from './claude-sdk'
import {
  createRunner,
  FIX_HOME,
  LOAD_NODE_MANAGERS,
  RESOLVE_CODEX_BIN,
  augmentWindowsPath,
  resolveClaudeCodeExecutable,
} from './driver/runner'

export const CODEX_SYSTEM_TEXT_MODEL = 'gpt-5.6-luna'
const CODEX_SYSTEM_TEXT_REASONING_EFFORT = 'low'
const CLAUDE_SYSTEM_TEXT_MODEL = 'haiku'
const SYSTEM_TEXT_TIMEOUT_MS = 120_000

export interface SystemTextOptions {
  cwd: string
  /** Structured-output schema. Only the Codex attempt can enforce it — the
   *  other providers just see the "return only JSON" instruction in the prompt. */
  schema?: unknown
  ssh?: SshConfig | null
  wsl?: WslConfig | null
}

/**
 * One entry of the automatic-generation provider chain. Each attempt must be
 * self-contained: missing binaries fail fast (spawn error / exit 127), so the
 * chain is cheap to walk even when most providers are not installed.
 */
interface SystemTextAttempt {
  provider: string
  query: () => Promise<string>
}

/**
 * Shell snippet that puts the directory of an installed CLI on PATH so the
 * runner's plain binary name (which the wsl/ssh adapters shell-escape, so it
 * cannot be a `$VAR` placeholder) resolves to the discovered install.
 * Exits 127 when the CLI is not present — the chain treats that as "skip".
 */
export function buildRemoteResolvePreamble(cmd: string, varName: string): string {
  return [
    `${FIX_HOME}; ${LOAD_NODE_MANAGERS}`,
    `${varName}="$(command -v ${cmd} 2>/dev/null || true)"`,
    `case "$${varName}" in /mnt/c/*) ${varName}="";; esac`,
    `[ -z "$${varName}" ] && for _C in "$HOME/.local/bin/${cmd}" "$HOME/.npm/bin/${cmd}" "$HOME/.npm-global/bin/${cmd}" "$HOME/.volta/bin/${cmd}" "$HOME/.bun/bin/${cmd}" "$HOME/bin/${cmd}"; do [ -x "$_C" ] && ${varName}="$_C" && break; done`,
    `[ -n "$${varName}" ] && export PATH="$(dirname "$${varName}"):$PATH" || { echo "${cmd} not found" >&2; exit 127; }`,
  ].join('; ')
}

/** Run a lightweight, read-only Codex completion for PolyCode-generated text. */
async function queryCodex(prompt: string, options: SystemTextOptions): Promise<string> {
  const runner = createRunner({ ssh: options.ssh, wsl: options.wsl })
  const useLocalOutputFiles = runner.type === 'local'
  const suffix = `${process.pid}-${randomUUID()}`
  const schemaPath = options.schema && useLocalOutputFiles
    ? path.join(tmpdir(), `polycode-system-text-${suffix}.schema.json`)
    : null
  const outputPath = useLocalOutputFiles
    ? path.join(tmpdir(), `polycode-system-text-${suffix}.output.txt`)
    : null

  try {
    if (schemaPath) await fsPromises.writeFile(schemaPath, JSON.stringify(options.schema), 'utf8')
    if (outputPath) await fsPromises.writeFile(outputPath, '', 'utf8')

    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      CODEX_SYSTEM_TEXT_MODEL,
      '--config',
      `model_reasoning_effort="${CODEX_SYSTEM_TEXT_REASONING_EFFORT}"`,
    ]
    if (schemaPath) args.push('--output-schema', schemaPath)
    if (outputPath) args.push('--output-last-message', outputPath)
    args.push('-')

    const result = await runner.run({
      binary: runner.type === 'local'
        ? (process.platform === 'win32' ? 'codex.cmd' : 'codex')
        // The preamble resolves CODEX_BIN and prepends its directory to PATH,
        // so the escaped plain name resolves to the real install.
        : 'codex',
      args,
      workDir: options.cwd,
      preamble: `${RESOLVE_CODEX_BIN}; export PATH="$(dirname "$CODEX_BIN"):$PATH"`,
      stdinContent: prompt,
      timeoutMs: SYSTEM_TEXT_TIMEOUT_MS,
    })

    if (result.timedOut) throw new Error('Codex system text generation timed out')
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim()
      throw new Error(detail ? `Codex system text generation failed: ${detail}` : `Codex system text generation failed with code ${result.exitCode}`)
    }

    const generated = outputPath
      ? (await fsPromises.readFile(outputPath, 'utf8')).trim()
      : result.stdout.trim()
    if (!generated) throw new Error('Codex did not return system text')
    return generated
  } finally {
    await Promise.all([
      schemaPath ? fsPromises.unlink(schemaPath).catch(() => undefined) : Promise.resolve(),
      outputPath ? fsPromises.unlink(outputPath).catch(() => undefined) : Promise.resolve(),
    ])
  }
}

/** One-shot Claude Code print-mode query; the prompt travels via stdin. */
export async function queryClaudeCli(prompt: string, options: SystemTextOptions): Promise<string> {
  const runner = createRunner({ ssh: options.ssh, wsl: options.wsl })
  const result = await runner.run({
    binary: runner.type === 'local' && process.platform === 'win32'
      ? resolveClaudeCodeExecutable(augmentWindowsPath())
      : 'claude',
    args: ['-p', '--output-format', 'text', '--model', CLAUDE_SYSTEM_TEXT_MODEL, '--max-turns', '1', '--strict-mcp-config'],
    workDir: options.cwd,
    preamble: runner.type === 'local' ? undefined : buildRemoteResolvePreamble('claude', 'CLAUDE_BIN'),
    stdinContent: prompt,
    timeoutMs: SYSTEM_TEXT_TIMEOUT_MS,
  })

  if (result.timedOut) throw new Error('Claude system text generation timed out')
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(detail || `Claude system text generation failed with code ${result.exitCode}`)
  }
  const generated = result.stdout.trim()
  if (!generated) throw new Error('Claude did not return system text')
  return generated
}

/** Extract the assistant text from `opencode run --format json` NDJSON output. */
export function parseOpenCodeText(raw: string): string {
  const parts: string[] = []
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const data = JSON.parse(trimmed) as { type?: unknown; part?: { type?: unknown; text?: unknown } }
      if (data.type === 'text' && typeof data.part?.text === 'string') parts.push(data.part.text)
    } catch {
      // Skip lines that are not JSON events.
    }
  }
  return parts.join('').trim() || raw.trim()
}

/** One-shot OpenCode query; the prompt travels via stdin. */
async function queryOpenCode(prompt: string, options: SystemTextOptions): Promise<string> {
  const runner = createRunner({ ssh: options.ssh, wsl: options.wsl })
  const result = await runner.run({
    binary: 'opencode',
    args: ['run', '--format', 'json'],
    workDir: options.cwd,
    preamble: runner.type === 'local' ? undefined : buildRemoteResolvePreamble('opencode', 'OPENCODE_BIN'),
    stdinContent: prompt,
    timeoutMs: SYSTEM_TEXT_TIMEOUT_MS,
  })

  if (result.timedOut) throw new Error('OpenCode system text generation timed out')
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(detail || `OpenCode system text generation failed with code ${result.exitCode}`)
  }
  const generated = parseOpenCodeText(result.stdout)
  if (!generated) throw new Error('OpenCode did not return system text')
  return generated
}

/** One-shot Pi print-mode query; the prompt travels via stdin. */
async function queryPi(prompt: string, options: SystemTextOptions): Promise<string> {
  const runner = createRunner({ ssh: options.ssh, wsl: options.wsl })
  const result = await runner.run({
    binary: 'pi',
    args: ['--print', '--no-tools', '--no-session', '--mode', 'text'],
    workDir: options.cwd,
    preamble: runner.type === 'local' ? undefined : buildRemoteResolvePreamble('pi', 'PI_BIN'),
    stdinContent: prompt,
    timeoutMs: SYSTEM_TEXT_TIMEOUT_MS,
  })

  if (result.timedOut) throw new Error('Pi system text generation timed out')
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(detail || `Pi system text generation failed with code ${result.exitCode}`)
  }
  const generated = result.stdout.trim()
  if (!generated) throw new Error('Pi did not return system text')
  return generated
}

/** Walk the provider chain until one attempt succeeds; aggregate failures otherwise. */
export async function runSystemTextChain(attempts: SystemTextAttempt[]): Promise<string> {
  const failures: string[] = []

  for (const attempt of attempts) {
    try {
      const generated = await attempt.query()
      if (generated.trim()) return generated
      failures.push(`${attempt.provider}: returned empty output`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[system-text] ${attempt.provider} unavailable: ${message}`)
      failures.push(`${attempt.provider}: ${message}`)
    }
  }

  throw new Error(`No text-generation provider available — ${failures.join(' | ')}`)
}

function buildSystemTextAttempts(prompt: string, options: SystemTextOptions): SystemTextAttempt[] {
  return [
    { provider: 'codex', query: () => queryCodex(prompt, options) },
    { provider: 'claude', query: () => queryClaudeCli(prompt, options) },
    { provider: 'opencode', query: () => queryOpenCode(prompt, options) },
    { provider: 'pi', query: () => queryPi(prompt, options) },
    // Last resort: the bundled Agent SDK needs no CLI on PATH, but only ever
    // sees this machine — remote (WSL/SSH) credentials are reached by the CLI
    // attempts above instead.
    { provider: 'claude-sdk', query: () => simpleQuery(prompt) },
  ]
}

/**
 * Run a lightweight, read-only completion for PolyCode-generated text
 * (commit messages, branch names, PR text, thread titles).
 * Tries each installed provider CLI in turn so a missing Codex install
 * degrades to Claude/OpenCode/Pi instead of failing the feature.
 */
export async function querySystemText(prompt: string, options: SystemTextOptions): Promise<string> {
  return runSystemTextChain(buildSystemTextAttempts(prompt, options))
}

export async function generateTitle(
  seedMessage: string,
  cwd: string,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const prompt =
    `In 5 words or fewer, write a short title for a coding session that started with this request. ` +
    `Reply with ONLY the title, no quotes, no punctuation at the end:\n\n${seedMessage.slice(0, 500)}`

  const title = await querySystemText(prompt, { cwd, ssh, wsl })
  return title.slice(0, 60)
}
