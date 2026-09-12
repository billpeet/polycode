import { describe, expect, it } from 'vitest'
import { RPC_TIMEOUT_MS, SLOW_RPC_TIMEOUT_MS, TEXT_GENERATION_RPC_TIMEOUT_MS, rpcTimeoutMs } from '../rpc-timeouts'

describe('rpcTimeoutMs', () => {
  it('gives inline filesystem work minutes, LLM text generation two minutes, and everything else the default', () => {
    expect(rpcTimeoutMs('locations:removeWorktree')).toBe(SLOW_RPC_TIMEOUT_MS)
    expect(rpcTimeoutMs('projects:createFull')).toBe(SLOW_RPC_TIMEOUT_MS)
    expect(rpcTimeoutMs('git:generateCommitMessage')).toBe(TEXT_GENERATION_RPC_TIMEOUT_MS)
    expect(rpcTimeoutMs('threads:list')).toBe(RPC_TIMEOUT_MS)
  })

  it('orders the budgets so a slow operation is never the shortest', () => {
    expect(SLOW_RPC_TIMEOUT_MS).toBeGreaterThan(TEXT_GENERATION_RPC_TIMEOUT_MS)
    expect(TEXT_GENERATION_RPC_TIMEOUT_MS).toBeGreaterThan(RPC_TIMEOUT_MS)
  })
})
