import { describe, it, expect, beforeEach } from 'bun:test'
import { CodexDriver, buildCodexArgs, winQuote, parseBashCommand } from '../codex'
import type { OutputEvent } from '../../../shared/types'
import type { DriverOptions } from '../types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDriver(opts: Partial<DriverOptions> = {}): CodexDriver {
  return new CodexDriver({
    workingDir: '/tmp/test',
    threadId: 'test-thread',
    ...opts,
  })
}

/** Call the private parseCodexEvent method via any-cast. */
function parse(driver: CodexDriver, data: Record<string, unknown>): OutputEvent[] {
  return (driver as any).parseCodexEvent(data)
}

/** Feed a full JSONL string through processBuffer and collect events. */
function feed(driver: CodexDriver, jsonl: string): OutputEvent[] {
  const events: OutputEvent[] = []
  ;(driver as any).buffer = jsonl + '\n'
  ;(driver as any).processBuffer((e: OutputEvent) => events.push(e))
  return events
}

// ── buildCodexArgs ────────────────────────────────────────────────────────────

describe('buildCodexArgs', () => {
  it('new conversation: options before prompt', () => {
    const args = buildCodexArgs(null, undefined, 'hello world')
    expect(args).toEqual(['exec', '--json', '--full-auto', 'hello world'])
  })

  it('new conversation: model flag before prompt', () => {
    const args = buildCodexArgs(null, 'gpt-5.3-codex', 'hello world')
    expect(args).toEqual(['exec', '--json', '--full-auto', '-c', 'model=gpt-5.3-codex', 'hello world'])
  })

  it('resume: subcommand + options before session_id + prompt', () => {
    const args = buildCodexArgs('session-123', 'gpt-5.3-codex', 'continue')
    expect(args).toEqual([
      'exec', '--json', 'resume', '--full-auto', '-c', 'model=gpt-5.3-codex',
      'session-123', 'continue',
    ])
  })

  it('resume without model', () => {
    const args = buildCodexArgs('session-123', undefined, 'continue')
    expect(args).toEqual(['exec', '--json', 'resume', '--full-auto', 'session-123', 'continue'])
  })

  it('prompt is always the last element', () => {
    const args = buildCodexArgs('sid', 'model-x', 'my prompt with spaces')
    expect(args[args.length - 1]).toBe('my prompt with spaces')
  })

  it('--full-auto always precedes session_id and prompt', () => {
    const args = buildCodexArgs('sid', 'model-x', 'prompt')
    const fullAutoIdx = args.indexOf('--full-auto')
    const sidIdx = args.indexOf('sid')
    const promptIdx = args.indexOf('prompt')
    expect(fullAutoIdx).toBeLessThan(sidIdx)
    expect(fullAutoIdx).toBeLessThan(promptIdx)
  })
})

// ── winQuote ──────────────────────────────────────────────────────────────────

describe('winQuote', () => {
  it('leaves simple flags unquoted', () => {
    expect(winQuote('--full-auto')).toBe('--full-auto')
    expect(winQuote('exec')).toBe('exec')
    expect(winQuote('--json')).toBe('--json')
  })

  it('wraps strings with spaces in double quotes', () => {
    expect(winQuote('hello world')).toBe('"hello world"')
  })

  it('wraps strings with tabs in double quotes', () => {
    expect(winQuote('hello\tworld')).toBe('"hello\tworld"')
  })

  it('escapes embedded double quotes', () => {
    expect(winQuote('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('wraps strings containing cmd special chars', () => {
    expect(winQuote('a&b')).toBe('"a&b"')
    expect(winQuote('a|b')).toBe('"a|b"')
    expect(winQuote('a<b')).toBe('"a<b"')
    expect(winQuote('a>b')).toBe('"a>b"')
    expect(winQuote('a^b')).toBe('"a^b"')
  })

  it('model=x-y-z style args are left unquoted', () => {
    expect(winQuote('model=gpt-5.3-codex')).toBe('model=gpt-5.3-codex')
  })
})

// ── parseBashCommand ──────────────────────────────────────────────────────────

describe('parseBashCommand', () => {
  it('extracts inner command from /bin/bash -lc double-quoted', () => {
    const { name, innerCmd } = parseBashCommand('/bin/bash -lc "ls -la && cat file.txt"')
    expect(name).toBe('Bash')
    expect(innerCmd).toBe('ls -la && cat file.txt')
  })

  it('extracts inner command from /bin/bash -lc single-quoted', () => {
    const { name, innerCmd } = parseBashCommand("/bin/bash -lc 'cat peanut-poem.txt'")
    expect(name).toBe('Bash')
    expect(innerCmd).toBe('cat peanut-poem.txt')
  })

  it('handles bare bash -lc', () => {
    const { name, innerCmd } = parseBashCommand('bash -lc "echo hi"')
    expect(name).toBe('Bash')
    expect(innerCmd).toBe('echo hi')
  })

  it('returns Shell + raw string for non-bash commands', () => {
    const { name, innerCmd } = parseBashCommand('pwsh.exe -Command ls')
    expect(name).toBe('Shell')
    expect(innerCmd).toBe('pwsh.exe -Command ls')
  })

  it('preserves multiline inner commands (heredoc write)', () => {
    const raw = "/bin/bash -lc \"cat > file.txt << 'EOF'\\nline1\\nEOF\""
    const { name, innerCmd } = parseBashCommand(raw)
    expect(name).toBe('Bash')
    expect(innerCmd).toContain('cat > file.txt')
  })
})

// ── Event parser ──────────────────────────────────────────────────────────────

describe('parseCodexEvent — thread.started', () => {
  it('captures thread_id and calls onSessionId', () => {
    let captured: string | undefined
    const driver = makeDriver({ onSessionId: (id) => { captured = id } })
    const events = parse(driver, {
      type: 'thread.started',
      thread_id: '019c837c-8622-7dc0-a155-0209677016bd',
    })
    expect(events).toHaveLength(0)
    expect(captured).toBe('019c837c-8622-7dc0-a155-0209677016bd')
    expect((driver as any).codexThreadId).toBe('019c837c-8622-7dc0-a155-0209677016bd')
  })

  it('does nothing when thread_id is missing', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'thread.started' })
    expect(events).toHaveLength(0)
    expect((driver as any).codexThreadId).toBeNull()
  })
})

describe('parseCodexEvent — item.completed / agent_message', () => {
  it('emits text event for agent_message', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'Hi there.' },
    })
    expect(events).toEqual([{ type: 'text', content: 'Hi there.' }])
  })

  it('skips agent_message text if already streamed via deltas', () => {
    const driver = makeDriver()
    // Simulate prior delta for item_0
    ;(driver as any).streamedItemIds.add('item_0')
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'full text' },
    })
    expect(events).toHaveLength(0)
  })

  it('emits text if item_id is absent (cannot be in streamedItemIds)', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'no id' },
    })
    expect(events).toEqual([{ type: 'text', content: 'no id' }])
  })
})

describe('parseCodexEvent — item.completed / command_execution', () => {
  it('emits tool_call + tool_result using aggregated_output', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: {
        id: 'item_11',
        type: 'command_execution',
        command: '/bin/bash -lc "ls -la"',
        aggregated_output: 'file1.txt\nfile2.txt',
      },
    })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('tool_call')
    // command is unwrapped: content = first line of inner command
    expect(events[0].content).toBe('ls -la')
    expect(events[0].metadata?.name).toBe('Bash')
    expect((events[0].metadata?.input as Record<string, unknown>)?.command).toBe('ls -la')
    expect(events[1].type).toBe('tool_result')
    expect(events[1].content).toBe('file1.txt\nfile2.txt')
    // metadata must have type:'tool_result' and tool_use_id so the renderer can pair them
    expect(events[1].metadata?.type).toBe('tool_result')
    expect(events[1].metadata?.tool_use_id).toBe('item_11')
  })

  it('does not emit a second tool_result for a replayed item.completed', () => {
    const driver = makeDriver()
    ;(driver as any).completedItemIds.add('item_11')
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_11', type: 'command_execution', command: 'ls', aggregated_output: 'out' },
    })
    expect(events).toHaveLength(0)
  })

  it('suppresses duplicate tool_call if item.started already fired', () => {
    const driver = makeDriver()
    ;(driver as any).announcedItemIds.add('item_11')
    const events = parse(driver, {
      type: 'item.completed',
      item: {
        id: 'item_11',
        type: 'command_execution',
        command: 'ls',
        aggregated_output: 'output',
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tool_result')
  })

  it('falls back to output field when aggregated_output absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_5', type: 'command_execution', command: 'ls', output: 'fallback' },
    })
    const result = events.find(e => e.type === 'tool_result')
    expect(result?.content).toBe('fallback')
  })

  it('emits tool_result with empty content when output fields are all absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_9', type: 'command_execution', command: 'ls' },
    })
    const result = events.find(e => e.type === 'tool_result')
    // Must always emit a result so pairMessages() can mark the call as DONE
    expect(result).toBeDefined()
    expect(result?.content).toBe('')
  })

  it('emits tool_result with empty content when aggregated_output is empty string', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_6', type: 'command_execution', command: 'cat > file.txt', aggregated_output: '' },
    })
    const result = events.find(e => e.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result?.content).toBe('')
    expect(result?.metadata?.tool_use_id).toBe('item_6')
  })
})

describe('parseCodexEvent — item.completed / reasoning', () => {
  it('emits no events for reasoning items', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.completed',
      item: { id: 'item_12', type: 'reasoning', text: '**Planning fallback**' },
    })
    expect(events).toHaveLength(0)
  })
})

describe('parseCodexEvent — item.started', () => {
  it('emits tool_call and marks item as announced', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.started',
      item: { id: 'item_11', type: 'command_execution', command: '/bin/bash -lc "pwsh.exe -Command ls"' },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('tool_call')
    expect(events[0].metadata?.name).toBe('Bash')
    expect((events[0].metadata?.input as Record<string, unknown>)?.command).toBe('pwsh.exe -Command ls')
    expect((driver as any).announcedItemIds.has('item_11')).toBeTrue()
  })

  it('does not emit a second tool_call for a replayed item.started', () => {
    const driver = makeDriver()
    ;(driver as any).announcedItemIds.add('item_11')
    const events = parse(driver, {
      type: 'item.started',
      item: { id: 'item_11', type: 'command_execution', command: 'ls' },
    })
    expect(events).toHaveLength(0)
  })

  it('does not emit tool_call for agent_message items', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.started',
      item: { id: 'item_0', type: 'agent_message' },
    })
    expect(events).toHaveLength(0)
  })

  it('does not emit tool_call for reasoning items', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.started',
      item: { id: 'item_2', type: 'reasoning' },
    })
    expect(events).toHaveLength(0)
  })

  it('uses path as label when command is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.started',
      item: { id: 'item_3', type: 'file_edit', path: '/src/main.ts' },
    })
    expect(events[0].content).toBe('/src/main.ts')
  })

  it('falls back to item type as label', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.started',
      item: { id: 'item_4', type: 'web_search' },
    })
    expect(events[0].content).toBe('web_search')
  })
})

describe('parseCodexEvent — item.agentMessage.delta', () => {
  it('emits text event and marks item_id as streamed', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'item.agentMessage.delta',
      item_id: 'item_0',
      delta: 'Hello ',
    })
    expect(events).toEqual([{ type: 'text', content: 'Hello ' }])
    expect((driver as any).streamedItemIds.has('item_0')).toBeTrue()
  })

  it('emits nothing when delta is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'item.agentMessage.delta', item_id: 'item_0' })
    expect(events).toHaveLength(0)
  })
})

describe('parseCodexEvent — turn.completed', () => {
  it('emits usage event with input and output tokens', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'turn.completed',
      usage: { input_tokens: 7518, cached_input_tokens: 6528, output_tokens: 5 },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('usage')
    expect(events[0].metadata).toEqual({ input_tokens: 7518, output_tokens: 5 })
  })

  it('emits no usage event when usage is absent', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'turn.completed' })
    expect(events).toHaveLength(0)
  })

  it('emits no usage when both token counts are zero', () => {
    const driver = makeDriver()
    const events = parse(driver, {
      type: 'turn.completed',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(events).toHaveLength(0)
  })
})

describe('parseCodexEvent — turn.failed / error', () => {
  it('emits error event on turn.failed', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'turn.failed', message: 'context limit exceeded' })
    expect(events).toEqual([{ type: 'error', content: 'context limit exceeded' }])
  })

  it('emits error event on error type', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'error', error: 'rate limited' })
    expect(events).toEqual([{ type: 'error', content: 'rate limited' }])
  })

  it('falls back to generic message when fields absent', () => {
    const driver = makeDriver()
    const events = parse(driver, { type: 'turn.failed' })
    expect(events[0].content).toBe('Unknown Codex error')
  })
})

describe('parseCodexEvent — no-ops', () => {
  it('emits nothing for turn.started', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'turn.started' })).toHaveLength(0)
  })

  it('emits nothing for unknown types', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'something.new.in.future.version' })).toHaveLength(0)
  })

  it('emits nothing for item.completed with no item payload', () => {
    const driver = makeDriver()
    expect(parse(driver, { type: 'item.completed' })).toHaveLength(0)
  })
})

// ── Full turn sequence (feed) ─────────────────────────────────────────────────

describe('full turn sequence', () => {
  it('processes the real observed "hi" output correctly', () => {
    const driver = makeDriver()
    const lines = [
      '{"type":"thread.started","thread_id":"019c837c-8622-7dc0-a155-0209677016bd"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi."}}',
      '{"type":"turn.completed","usage":{"input_tokens":7518,"cached_input_tokens":6528,"output_tokens":5}}',
    ].join('\n')

    const events = feed(driver, lines)

    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', content: 'Hi.' }])
    expect(events.filter(e => e.type === 'usage')).toHaveLength(1)
    expect((driver as any).codexThreadId).toBe('019c837c-8622-7dc0-a155-0209677016bd')
  })

  it('item.started + item.completed produces exactly one tool_call', () => {
    const driver = makeDriver()
    const lines = [
      '{"type":"item.started","item":{"id":"item_11","type":"command_execution","command":"/bin/bash -lc \\"ls\""}}',
      '{"type":"item.completed","item":{"id":"item_11","type":"command_execution","command":"/bin/bash -lc \\"ls\\"","aggregated_output":"file.txt"}}',
    ].join('\n')

    const events = feed(driver, lines)
    const toolCalls = events.filter(e => e.type === 'tool_call')
    const toolResults = events.filter(e => e.type === 'tool_result')

    expect(toolCalls).toHaveLength(1)
    expect(toolResults).toHaveLength(1)
    expect(toolCalls[0].metadata?.name).toBe('Bash')
    expect(toolResults[0].content).toBe('file.txt')
    expect(toolResults[0].metadata?.type).toBe('tool_result')
    expect(toolResults[0].metadata?.tool_use_id).toBe('item_11')
  })

  it('replayed items after turn.completed produce no extra events', () => {
    const driver = makeDriver()
    const firstTurn = [
      '{"type":"item.started","item":{"id":"item_5","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"item_5","type":"command_execution","command":"ls","aggregated_output":"file.txt"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    ].join('\n')
    const replay = [
      '{"type":"item.started","item":{"id":"item_5","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"item_5","type":"command_execution","command":"ls","aggregated_output":"file.txt"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    ].join('\n')

    const firstEvents = feed(driver, firstTurn)
    const replayEvents = feed(driver, replay)

    expect(firstEvents.filter(e => e.type === 'tool_call')).toHaveLength(1)
    expect(firstEvents.filter(e => e.type === 'tool_result')).toHaveLength(1)
    // replayed items must produce zero extra tool events
    expect(replayEvents.filter(e => e.type === 'tool_call')).toHaveLength(0)
    expect(replayEvents.filter(e => e.type === 'tool_result')).toHaveLength(0)
  })

  it('streaming deltas followed by item.completed does not double-emit text', () => {
    const driver = makeDriver()
    const lines = [
      '{"type":"item.agentMessage.delta","item_id":"item_0","delta":"Hello "}',
      '{"type":"item.agentMessage.delta","item_id":"item_0","delta":"world"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello world"}}',
    ].join('\n')

    const events = feed(driver, lines)
    const texts = events.filter(e => e.type === 'text')

    // Two delta events only — item.completed text suppressed
    expect(texts).toHaveLength(2)
    expect(texts.map(e => e.content)).toEqual(['Hello ', 'world'])
  })

  it('reasoning items are silently skipped in a multi-item turn', () => {
    const driver = makeDriver()
    const lines = [
      '{"type":"item.completed","item":{"id":"item_12","type":"reasoning","text":"**Planning**"}}',
      '{"type":"item.completed","item":{"id":"item_13","type":"agent_message","text":"Done."}}',
    ].join('\n')

    const events = feed(driver, lines)
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', content: 'Done.' }])
  })
})
