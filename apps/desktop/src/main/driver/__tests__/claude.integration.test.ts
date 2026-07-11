import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeCodeExecutable } from '../runner'

const RUN_INTEGRATION = process.env.CLAUDE_INTEGRATION === '1'
const SKILL_NAME = 'polycode-itest-resolution'
const SKILL_DIR = path.join(homedir(), '.claude', 'skills', SKILL_NAME)
const SKILL_PATH = path.join(SKILL_DIR, 'SKILL.md')

describe.skipIf(!RUN_INTEGRATION)('ClaudeDriver integration', () => {
  beforeAll(() => {
    mkdirSync(SKILL_DIR, { recursive: true })
    writeFileSync(
      SKILL_PATH,
      `---
description: Use this skill when the user asks whether polycode integration tests can verify Claude skill loading. If this skill is used, begin the response with the exact token POLYCODE_ITEST_TRIGGERED.
---

If this skill is used, begin the response with the exact token POLYCODE_ITEST_TRIGGERED on its own line.
`
    )
  })

  afterAll(() => {
    rmSync(SKILL_DIR, { recursive: true, force: true })
  })

  it('surfaces user-installed personal skills through the SDK command list', async () => {
    const q = query({
      prompt: 'Reply with OK.',
      options: {
        cwd: process.cwd(),
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
        settingSources: ['user', 'project', 'local'],
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })

    try {
      const commands = await q.supportedCommands()
      const names = commands.map((command) => command.name)
      expect(names).toContain(SKILL_NAME)
    } finally {
      await q.close()
    }
  }, 30000)
})
