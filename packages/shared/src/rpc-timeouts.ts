/**
 * Per-channel budgets for a remote-control RPC. One table for every client that speaks
 * to a Remote Host over HTTP (the desktop controller and the browser client), so a
 * channel that legitimately runs for minutes on the host is not abandoned by one of them.
 */

export const RPC_TIMEOUT_MS = 10_000

// Text generation runs an LLM subprocess on the host. Match system-text's own two-minute
// command budget so the remote transport does not give up while that subprocess is healthy.
export const TEXT_GENERATION_RPC_TIMEOUT_MS = 120_000
const TEXT_GENERATION_RPC_CHANNELS: ReadonlySet<string> = new Set([
  'git:generateCommitMessage',
  'git:generateCommitMessageWithContext',
  'git:generateBranchName',
  'git:generatePullRequestText',
])

// Channels whose host-side handler does the filesystem work inline (worktree removal is a
// `git worktree remove --force` plus a recursive delete of a directory that routinely holds
// `node_modules`). A 10s budget guarantees these fail on the client while the host happily
// finishes the job minutes later.
export const SLOW_RPC_TIMEOUT_MS = 300_000
const SLOW_RPC_CHANNELS: ReadonlySet<string> = new Set([
  'locations:createWorktree',
  'locations:removeWorktree',
  'locations:clone',
  'projects:createFull',
])

export function rpcTimeoutMs(channel: string): number {
  if (SLOW_RPC_CHANNELS.has(channel)) return SLOW_RPC_TIMEOUT_MS
  if (TEXT_GENERATION_RPC_CHANNELS.has(channel)) return TEXT_GENERATION_RPC_TIMEOUT_MS
  return RPC_TIMEOUT_MS
}
