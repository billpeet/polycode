// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PullRequestDetails } from './PullRequestDetails'
import type { PullRequest } from '../../types/ipc'

afterEach(cleanup)

it('shows running CI and links each available pipeline run', () => {
  const pr = {
    checkStatus: 'processing',
    checks: [
      { name: 'Build', status: 'processing', url: 'https://dev.azure.com/org/project/_build/results?buildId=42' },
      { name: 'Tests', status: 'failed', url: 'https://dev.azure.com/org/project/_build/results?buildId=43' },
      { name: 'Deploy', status: 'processing' },
    ],
  } as PullRequest
  render(<PullRequestDetails pr={pr} />)
  expect(screen.getByText('Checks running')).toBeTruthy()
  expect(screen.getByRole('link', { name: /Build: Queued \/ running/ }).getAttribute('href')).toBe(pr.checks![0].url)
  expect(screen.getByRole('link', { name: /Tests: Failed/ }).getAttribute('href')).toBe(pr.checks![1].url)
  expect(screen.getAllByRole('link')).toHaveLength(2)
  expect(screen.getByText('Deploy: Queued / running')).toBeTruthy()
})

it('keeps the existing GitHub aggregate check badge', () => {
  render(<PullRequestDetails pr={{ checkStatus: 'passed' } as PullRequest} />)
  expect(screen.getByText('Checks passed')).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
})
