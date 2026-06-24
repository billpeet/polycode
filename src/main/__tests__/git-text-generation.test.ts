import { describe, expect, it } from 'bun:test'
import {
  buildCommitMessagePrompt,
  buildPullRequestTextPrompt,
  formatCommitMessage,
  formatPullRequestText,
  generatePullRequestTextFromContext,
  parseCommitMessageResponse,
  parsePullRequestTextResponse,
  sanitizeCommitSubject,
  sanitizePullRequestTitle,
} from '../git-text-generation'

describe('git text generation', () => {
  it('parses fenced JSON commit messages', () => {
    const parsed = parseCommitMessageResponse('```json\n{"subject":"fix: handle empty diffs.","body":"- Keep existing message"}\n```')

    expect(formatCommitMessage(parsed)).toBe('fix: handle empty diffs\n\n- Keep existing message')
  })

  it('extracts JSON when the model adds surrounding text', () => {
    const parsed = parseCommitMessageResponse('Here is the commit message:\n{"subject":"feat: add source control cache","body":""}\nThanks')

    expect(formatCommitMessage(parsed)).toBe('feat: add source control cache')
  })

  it('falls back to text while sanitizing the subject', () => {
    const parsed = parseCommitMessageResponse('"docs: update source control plan."\n\n- Mention staged changes')

    expect(formatCommitMessage(parsed)).toBe('docs: update source control plan\n\n- Mention staged changes')
  })

  it('limits empty or overlong subjects', () => {
    expect(sanitizeCommitSubject('')).toBe('Update project files')
    expect(sanitizeCommitSubject(`chore: ${'x'.repeat(100)}`)).toHaveLength(72)
  })

  it('builds a bounded prompt from commit context', () => {
    const prompt = buildCommitMessagePrompt({
      branch: 'feature/git-generation',
      changeSummary: 'M\tsrc/main/git.ts',
      patch: `diff --git a/src/main/git.ts b/src/main/git.ts\n+${'x'.repeat(60_000)}`,
    })

    expect(prompt).toContain('Return only a JSON object')
    expect(prompt).toContain('Branch: feature/git-generation')
    expect(prompt).toContain('M\tsrc/main/git.ts')
    expect(prompt).toContain('[truncated]')
    expect(prompt.length).toBeLessThan(52_000)
  })

  it('parses fenced JSON pull request text', () => {
    const parsed = parsePullRequestTextResponse('```json\n{"title":"Add PR generation.","description":"## Summary\\n- Adds AI PR text"}\n```')

    expect(formatPullRequestText(parsed)).toEqual({
      title: 'Add PR generation',
      description: '## Summary\n- Adds AI PR text',
    })
  })

  it('falls back to plain pull request text', () => {
    const parsed = parsePullRequestTextResponse('PR title: Improve source control UX.\n\n## Summary\n- Adds a button')

    expect(formatPullRequestText(parsed)).toEqual({
      title: 'Improve source control UX',
      description: '## Summary\n- Adds a button',
    })
  })

  it('limits empty or overlong pull request titles', () => {
    expect(sanitizePullRequestTitle('')).toBe('Update project files')
    expect(sanitizePullRequestTitle(`Update ${'x'.repeat(120)}`)).toHaveLength(90)
  })

  it('builds a bounded prompt from pull request context', () => {
    const prompt = buildPullRequestTextPrompt({
      sourceBranch: 'feature/pr-generation',
      targetBranch: 'main',
      baseRef: 'origin/main',
      commitSummary: '- abc123 Add PR generation',
      changeSummary: 'M\tsrc/main/git.ts',
      patch: `diff --git a/src/main/git.ts b/src/main/git.ts\n+${'x'.repeat(70_000)}`,
    })

    expect(prompt).toContain('Return only a JSON object')
    expect(prompt).toContain('Source branch: feature/pr-generation')
    expect(prompt).toContain('Target branch: main')
    expect(prompt).toContain('[truncated]')
    expect(prompt.length).toBeLessThan(54_000)
  })

  it('generates formatted pull request text from a query response', async () => {
    const text = await generatePullRequestTextFromContext({
      sourceBranch: 'feature/pr-generation',
      targetBranch: 'main',
      baseRef: 'origin/main',
      commitSummary: '- abc123 Add PR generation',
      changeSummary: 'M\tsrc/main/git-text-generation.ts',
      patch: 'diff --git a/src/main/git-text-generation.ts b/src/main/git-text-generation.ts\n+export const value = 1',
    }, async () => '{"title":"feat: add PR text generation.","description":"## Summary\\n- Generates PR copy"}')

    expect(text).toEqual({
      title: 'feat: add PR text generation',
      description: '## Summary\n- Generates PR copy',
    })
  })
})
