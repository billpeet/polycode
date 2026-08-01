import { randomUUID } from 'crypto'
import { promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import type { SshConfig, WslConfig } from '../shared/types'
import { simpleQuery } from './claude-sdk'
import { createRunner, RESOLVE_CODEX_BIN } from './driver/runner'

export const CODEX_SYSTEM_TEXT_MODEL = 'gpt-5.6-luna'
const CODEX_SYSTEM_TEXT_REASONING_EFFORT = 'low'
const CODEX_SYSTEM_TEXT_TIMEOUT_MS = 120_000

export interface CodexTextOptions {
  cwd: string
  schema?: unknown
  ssh?: SshConfig | null
  wsl?: WslConfig | null
}

/** Run a lightweight, read-only Codex completion for PolyCode-generated text. */
async function queryCodexPrimary(prompt: string, options: CodexTextOptions): Promise<string> {
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
        : '$CODEX_BIN',
      args,
      workDir: options.cwd,
      preamble: RESOLVE_CODEX_BIN,
      stdinContent: prompt,
      timeoutMs: CODEX_SYSTEM_TEXT_TIMEOUT_MS,
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

/** Prefer Codex for PolyCode-generated text, falling back to Claude Haiku when unavailable. */
export async function queryCodexText(prompt: string, options: CodexTextOptions): Promise<string> {
  try {
    return await queryCodexPrimary(prompt, options)
  } catch (error) {
    console.warn('[system-text] Falling back to Claude SDK:', error instanceof Error ? error.message : String(error))
    return simpleQuery(prompt)
  }
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

  const title = await queryCodexText(prompt, { cwd, ssh, wsl })
  return title.slice(0, 60)
}
