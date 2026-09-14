// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PullRequestDetails } from './PullRequestDetails'
import type { PullRequest } from '../../types/ipc'

afterEach(cleanup)

it('summarises running CI and links each unfinished pipeline run', () => {
  const pr = {
    checkStatus: 'processing',
    checks: [
      { name: 'Build', status: 'processing', url: 'https://dev.azure.com/org/project/_build/results?buildId=42' },
      { name: 'Tests', status: 'failed', url: 'https://dev.azure.com/org/project/_build/results?buildId=43' },
      { name: 'Deploy', status: 'processing' },
      { name: 'Lint', status: 'passed', url: 'https://dev.azure.com/org/project/_build/results?buildId=44' },
    ],
  } as PullRequest
  render(<PullRequestDetails pr={pr} />)
  expect(screen.getByRole('listitem', { name: /CI checks: processing/ }).textContent).toBe('1/4')
  expect(screen.getByRole('link', { name: 'Build: Queued / running' }).getAttribute('href')).toBe(pr.checks![0].url)
  expect(screen.getByRole('link', { name: 'Tests: Failed' }).getAttribute('href')).toBe(pr.checks![1].url)
  expect(screen.getAllByRole('link')).toHaveLength(2)
  expect(screen.getByLabelText('Deploy: Queued / running')).toBeTruthy()
  expect(screen.queryByText('Lint')).toBeNull()
})

it('keeps the GitHub aggregate check chip when no individual checks are known', () => {
  render(<PullRequestDetails pr={{ checkStatus: 'passed' } as PullRequest} />)
  expect(screen.getByRole('listitem', { name: 'CI checks: passed' }).textContent).toBe('Passed')
  expect(screen.queryByRole('link')).toBeNull()
})

it('shows merge, comment and review state as one chip each', () => {
  render(<PullRequestDetails pr={{ mergeStatus: 'ready', unresolvedCommentCount: 1, reviewStatus: 'changes-requested' } as PullRequest} />)
  expect(screen.getByRole('listitem', { name: 'Merge status: ready to merge' }).textContent).toBe('Ready')
  expect(screen.getByRole('listitem', { name: '1 unresolved review comment' }).textContent).toBe('1')
  expect(screen.getByRole('listitem', { name: 'Review status: changes requested' }).textContent).toBe('Changes')
})

it('renders nothing when there is no status to show', () => {
  const { container } = render(<PullRequestDetails pr={{} as PullRequest} />)
  expect(container.innerHTML).toBe('')
})
