import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalizes free-form input into a git-safe branch name:
 * lowercase kebab-case, preserving `/` separators (e.g. `feature/my-change`).
 */
export function toKebabBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(whitespace, '-')
    .replace(underscoreRuns, '-')
    .replace(invalidBranchChars, '')
    .replace(dashRuns, '-')
    .replace(leadingDashes, '')
}
const whitespace = /\s+/g
const underscoreRuns = /_+/g
const invalidBranchChars = /[^a-z0-9./-]+/g
const dashRuns = /-+/g
const leadingDashes = /^-+/
