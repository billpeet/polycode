import { describe, expect, it } from 'vitest'
import { toKebabBranchName } from '../utils'

describe('toKebabBranchName', () => {
  it('lowercases and converts spaces to dashes', () => {
    expect(toKebabBranchName('Fix Login Flow')).toBe('fix-login-flow')
  })

  it('converts underscores to dashes', () => {
    expect(toKebabBranchName('fix_login_flow')).toBe('fix-login-flow')
  })

  it('strips characters invalid in git branch names', () => {
    expect(toKebabBranchName('fix: login! flow?')).toBe('fix-login-flow')
  })

  it('preserves slash separators', () => {
    expect(toKebabBranchName('Feature/My Change')).toBe('feature/my-change')
  })

  it('collapses consecutive dashes', () => {
    expect(toKebabBranchName('fix  weird---name')).toBe('fix-weird-name')
  })

  it('strips leading dashes', () => {
    expect(toKebabBranchName('--my-branch')).toBe('my-branch')
  })

  it('keeps already-valid names unchanged', () => {
    expect(toKebabBranchName('feature/kebab-case-2')).toBe('feature/kebab-case-2')
  })
})
