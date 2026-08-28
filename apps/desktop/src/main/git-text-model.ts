import type { SshConfig, WslConfig } from '../shared/types'
import { querySystemText } from './system-text'
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

async function querySystemTextStructured(
  repoPath: string,
  prompt: string,
  schema: unknown,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  return querySystemText(prompt, { cwd: repoPath, schema, ssh, wsl })
}

export async function generateCommitMessageText(
  repoPath: string,
  context: CommitMessageContext,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const raw = await querySystemTextStructured(repoPath, buildCommitMessagePrompt(context), commitMessageSchema, ssh, wsl)
  return formatCommitMessage(parseCommitMessageResponse(raw))
}

export async function generatePullRequestText(
  repoPath: string,
  context: PullRequestTextContext,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<GeneratedPullRequestText> {
  const raw = await querySystemTextStructured(repoPath, buildPullRequestTextPrompt(context), pullRequestTextSchema, ssh, wsl)
  return formatPullRequestText(parsePullRequestTextResponse(raw))
}

export async function generateBranchNameText(
  repoPath: string,
  context: CommitMessageContext,
  ssh?: SshConfig | null,
  wsl?: WslConfig | null,
): Promise<string> {
  const raw = await querySystemTextStructured(repoPath, buildBranchNamePrompt(context), branchNameSchema, ssh, wsl)
  return sanitizeBranchName(parseBranchNameResponse(raw))
}
