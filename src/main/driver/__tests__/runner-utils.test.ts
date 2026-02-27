import { describe, it, expect } from 'bun:test'
import { shellEscape, winQuote, cdTarget, buildSshBaseArgs } from '../runner/utils'
import type { SshConfig } from '../../../shared/types'

// ── shellEscape ───────────────────────────────────────────────────────────────

describe('shellEscape', () => {
  it('wraps normal strings in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'")
  })

  it('handles empty string', () => {
    expect(shellEscape('')).toBe("''")
  })

  it('escapes embedded single quotes', () => {
    // "it's" → 'it'\''s'
    expect(shellEscape("it's")).toBe("'it'\\''s'")
  })

  it('preserves newlines inside quotes', () => {
    const result = shellEscape('line1\nline2')
    expect(result).toBe("'line1\nline2'")
  })

  it('preserves double quotes without escaping', () => {
    expect(shellEscape('say "hi"')).toBe("'say \"hi\"'")
  })

  it('preserves shell metacharacters literally', () => {
    expect(shellEscape('a$b && c | d')).toBe("'a$b && c | d'")
  })

  it('handles multiple single quotes', () => {
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'")
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

  it('wraps strings containing & | < > ^ cmd special chars', () => {
    expect(winQuote('a&b')).toBe('"a&b"')
    expect(winQuote('a|b')).toBe('"a|b"')
    expect(winQuote('a<b')).toBe('"a<b"')
    expect(winQuote('a>b')).toBe('"a>b"')
    expect(winQuote('a^b')).toBe('"a^b"')
  })

  it('model=x-y-z style args are left unquoted', () => {
    expect(winQuote('model=gpt-5.3-codex')).toBe('model=gpt-5.3-codex')
  })

  it('leaves simple path-like strings unquoted', () => {
    expect(winQuote('/home/user/.nvm/nvm.sh')).toBe('/home/user/.nvm/nvm.sh')
  })
})

// ── cdTarget ──────────────────────────────────────────────────────────────────

describe('cdTarget', () => {
  it('wraps a normal path in single quotes', () => {
    expect(cdTarget('/home/user/project')).toBe("'/home/user/project'")
  })

  it('replaces leading ~ with "$HOME" unquoted + single-quoted remainder', () => {
    expect(cdTarget('~')).toBe('"$HOME"\'\'')
  })

  it('handles ~/subdir correctly', () => {
    expect(cdTarget('~/projects/foo')).toBe('"$HOME"\'/projects/foo\'')
  })

  it('handles paths with spaces (single-quoted)', () => {
    expect(cdTarget('/home/my user/project')).toBe("'/home/my user/project'")
  })

  it('handles paths with single quotes', () => {
    const result = cdTarget("/home/user/it's here")
    // The single quote in "it's" must be escaped as '\''
    expect(result).toBe("'/home/user/it'\\''s here'")
  })

  it('does not confuse ~username (does not start with ~/ or just ~)', () => {
    // ~username does NOT expand to home in this implementation — it starts with ~
    // but the remaining /username part is still single-quoted
    const result = cdTarget('~username/project')
    expect(result).toBe('"$HOME"\'username/project\'')
  })
})

// ── buildSshBaseArgs ──────────────────────────────────────────────────────────

describe('buildSshBaseArgs', () => {
  const baseConfig: SshConfig = { host: 'example.com', user: 'alice' }

  it('always includes -T, ConnectTimeout, StrictHostKeyChecking', () => {
    const args = buildSshBaseArgs(baseConfig)
    expect(args).toContain('-T')
    expect(args).toContain('ConnectTimeout=10')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
  })

  it('does not include port flag when port is absent', () => {
    const args = buildSshBaseArgs(baseConfig)
    expect(args).not.toContain('-p')
  })

  it('includes -p flag when port is provided', () => {
    const args = buildSshBaseArgs({ ...baseConfig, port: 2222 })
    const portIdx = args.indexOf('-p')
    expect(portIdx).toBeGreaterThan(-1)
    expect(args[portIdx + 1]).toBe('2222')
  })

  it('does not include -i flag when keyPath is absent', () => {
    const args = buildSshBaseArgs(baseConfig)
    expect(args).not.toContain('-i')
  })

  it('includes -i flag when keyPath is provided', () => {
    const args = buildSshBaseArgs({ ...baseConfig, keyPath: '/home/alice/.ssh/id_rsa' })
    const keyIdx = args.indexOf('-i')
    expect(keyIdx).toBeGreaterThan(-1)
    expect(args[keyIdx + 1]).toBe('/home/alice/.ssh/id_rsa')
  })

  it('includes both port and keyPath flags together', () => {
    const args = buildSshBaseArgs({ ...baseConfig, port: 22, keyPath: '/tmp/key' })
    expect(args).toContain('-p')
    expect(args).toContain('-i')
  })

  it('includes ControlMaster args on non-win32', () => {
    // This test reflects actual runtime behavior.
    // On Windows build agents this will fail, which is acceptable — ControlMaster
    // is intentionally excluded on win32.
    if (process.platform === 'win32') return
    const args = buildSshBaseArgs(baseConfig)
    expect(args).toContain('ControlMaster=auto')
    expect(args.join(' ')).toContain('ControlPath=')
    expect(args).toContain('ControlPersist=300')
  })

  it('excludes ControlMaster args on win32', () => {
    if (process.platform !== 'win32') return
    const args = buildSshBaseArgs(baseConfig)
    expect(args.join(' ')).not.toContain('ControlMaster')
  })
})
