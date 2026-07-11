import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { simpleQuery } from './claude-sdk'
import { createRunner, RESOLVE_CODEX_BIN } from './driver/runner'
import type { SshConfig, WslConfig } from '../shared/types'
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPullRequestTextPrompt,
  formatCommitMessage,
  formatPullRequestText,
  parseBranchNameResponse,
  parseCommitMessageResponse,
  parsePullRequestTextResponse,
  sanitizeBranchName,
  type CommitMessageContext,
  type GeneratedPullRequestText,
  type PullRequestTextContext,
} from './git-text-generation'

const CODEX_TEXT_MODEL = 'gpt-5.4-mini'
const CODEX_TEXT_REASONING_EFFORT = 'low'
const CODEX_TEXT_TIMEOUT_MS = 120_000

const commitMessageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['subject', 'body'],
}

const pullRequestTextSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['title', 'description'],
}

const branchNameSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
  },
  required: ['branch'],
}

function readProcessOutput(proc: ChildProcess): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    proc.on('error', reject)
    proc.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }))
  })
}

async function withTempJsonFile(value: unknown): Promise<string> {
  const filePath = path.join(tmpdir(), `polycode-git-text-${process.pid}-${randomUUID()}.json`)
  await fsPromises.writeFile(filePath, JSON.stringify(value), 'utf8')
  return filePath
}

async function withTempOutputFile(): Promise<string> {
  const filePath = path.join(tmpdir(), `polycode-git-text-output-${process.pid}-${randomUUID()}.json`)
  await fsPromises.writeFile(filePath, '', 'utf8')
  return filePath
}

async function queryCodexStructured(
  repoPath: string,
  prompt: string,
  schema: unknown,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  if (ssh || wsl) {
    throw new Error('Codex structured git text generation is currently local-only')
  }

  const schemaPath = await withTempJsonFile(schema)
  const outputPath = await withTempOutputFile()
  try {
    const runner = createRunner({})
    const proc = runner.spawn({
      binary: process.platform === 'win32' ? 'codex.cmd' : 'codex',
      args: [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '--model',
        CODEX_TEXT_MODEL,
        '--config',
        `model_reasoning_effort="${CODEX_TEXT_REASONING_EFFORT}"`,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '-',
      ],
      workDir: repoPath,
      preamble: RESOLVE_CODEX_BIN,
      stdinContent: prompt,
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error('Codex git text generation timed out'))
      }, CODEX_TEXT_TIMEOUT_MS)
    })

    const { stdout, stderr, exitCode } = await Promise.race([readProcessOutput(proc), timeout])
      .finally(() => {
        if (timer) clearTimeout(timer)
      })
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim()
      throw new Error(detail ? `Codex git text generation failed: ${detail}` : `Codex git text generation failed with code ${exitCode}`)
    }

    const generated = (await fsPromises.readFile(outputPath, 'utf8')).trim()
    if (!generated) throw new Error('Codex did not return git text')
    return generated
  } finally {
    await Promise.all([
      fsPromises.unlink(schemaPath).catch(() => undefined),
      fsPromises.unlink(outputPath).catch(() => undefined),
    ])
  }
}

async function queryGitText(
  repoPath: string,
  prompt: string,
  schema: unknown,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  try {
    return await queryCodexStructured(repoPath, prompt, schema, ssh, wsl)
  } catch (error) {
    console.warn('[git-text] Falling back to Claude SDK:', error instanceof Error ? error.message : String(error))
    return simpleQuery(prompt)
  }
}

export async function generateCommitMessageText(
  repoPath: string,
  context: CommitMessageContext,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const raw = await queryGitText(repoPath, buildCommitMessagePrompt(context), commitMessageSchema, ssh, wsl)
  return formatCommitMessage(parseCommitMessageResponse(raw))
}

export async function generatePullRequestText(
  repoPath: string,
  context: PullRequestTextContext,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GeneratedPullRequestText> {
  const raw = await queryGitText(repoPath, buildPullRequestTextPrompt(context), pullRequestTextSchema, ssh, wsl)
  return formatPullRequestText(parsePullRequestTextResponse(raw))
}

export async function generateBranchNameText(
  repoPath: string,
  context: CommitMessageContext,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const raw = await queryGitText(repoPath, buildBranchNamePrompt(context), branchNameSchema, ssh, wsl)
  return sanitizeBranchName(parseBranchNameResponse(raw))
}
