import { SshConfig } from '../../../shared/types'

/** Escape a string for use inside single quotes in a POSIX shell. */
export function shellEscape(s: string): string {
  // Replace each ' with '\'' (end quote, escaped quote, start quote)
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Quote a single argument for cmd.exe (Windows shell).
 * When spawn uses shell:true on Windows, Node joins args with plain spaces,
 * so arguments with spaces must be explicitly double-quoted.
 */
export function winQuote(s: string): string {
  if (!/[ \t"&|<>^]/.test(s)) return s
  return '"' + s.replace(/"/g, '\\"') + '"'
}

/**
 * Build a cd target expression for a working directory.
 * ~ is replaced with unquoted "$HOME" so the shell expands it correctly
 * (tilde does not expand inside single quotes).
 */
export function cdTarget(workDir: string): string {
  return workDir.startsWith('~')
    ? '"$HOME"' + shellEscape(workDir.slice(1))
    : shellEscape(workDir)
}

/** Build base SSH args array (flags shared by all drivers). */
export function buildSshBaseArgs(ssh: SshConfig): string[] {
  const args = [
    '-T',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
  // ControlMaster multiplexing is not supported on Windows OpenSSH
  if (process.platform !== 'win32') {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=/tmp/polycode-ssh-%r@%h:%p',
      '-o', 'ControlPersist=300',
    )
  }
  if (ssh.port) {
    args.push('-p', String(ssh.port))
  }
  if (ssh.keyPath) {
    args.push('-i', ssh.keyPath)
  }
  return args
}

/**
 * Source common Node version managers explicitly so `codex` / node resolve
 * correctly in non-interactive login shells (WSL and SSH).
 *
 * Problem: bash -lc is a login shell but NOT interactive, so .bashrc typically
 * bails out before reaching nvm/volta/fnm setup.
 * nvm requires both sourcing the init script AND calling `nvm use default` to
 * add the active node version to PATH; sourcing alone only loads the function.
 */
export const LOAD_NODE_MANAGERS = [
  '[ -s "$HOME/.nvm/nvm.sh" ] && { source "$HOME/.nvm/nvm.sh"; nvm use default --silent 2>/dev/null; }',
  '[ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH"',
  '[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"',
  '[ -d "$HOME/.npm-global/bin" ] && export PATH="$HOME/.npm-global/bin:$PATH"',
  'command -v fnm &>/dev/null && eval "$(fnm env 2>/dev/null)"',
].join('; ')

/**
 * Fix the HOME variable in WSL.
 * Electron passes Windows environment variables (including HOME=/c/Users/...) to
 * WSL subprocesses. This Windows HOME overrides the Linux user's home even in a
 * login shell, causing nvm/volta/bun path lookups to fail.
 * Correct HOME from the password database before anything else.
 */
export const FIX_HOME = 'export HOME="$(getent passwd $(id -un) | cut -d: -f6)"'

/**
 * Resolve the codex binary path, skipping Windows /mnt/c/ interop paths.
 * WSL/SSH: the system PATH may resolve `codex` to a Windows wrapper at
 * /mnt/c/... which fails because the Linux node binary is absent.
 * Fall back to known Linux install locations.
 */
const RESOLVE_CODEX_BIN_LINES = [
  'CODEX_BIN=""',
  'command -v codex >/dev/null 2>&1 && CODEX_BIN="$(command -v codex)"',
  'case "$CODEX_BIN" in /mnt/c/*) CODEX_BIN="";; esac',
  '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.local/bin/codex" ] && CODEX_BIN="$HOME/.local/bin/codex"',
  '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.npm/bin/codex" ] && CODEX_BIN="$HOME/.npm/bin/codex"',
  '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.npm-global/bin/codex" ] && CODEX_BIN="$HOME/.npm-global/bin/codex"',
  '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.volta/bin/codex" ] && CODEX_BIN="$HOME/.volta/bin/codex"',
  '[ -z "$CODEX_BIN" ] && [ -x "$HOME/.bun/bin/codex" ] && CODEX_BIN="$HOME/.bun/bin/codex"',
  '[ -z "$CODEX_BIN" ] && [ -d "$HOME/.nvm/versions/node" ] && CODEX_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/codex 2>/dev/null | tail -n 1)"',
]

export const RESOLVE_CODEX_BIN = [
  ...RESOLVE_CODEX_BIN_LINES,
  '[ -n "$CODEX_BIN" ] || { echo "codex not found; PATH=$PATH" >&2; exit 127; }',
].join('; ')

/**
 * Like RESOLVE_CODEX_BIN but does NOT exit 127 on failure.
 * Sets CODEX_BIN="" when codex is not found — caller handles the missing case.
 * Used by health checks that gracefully report "codex not found".
 */
export const RESOLVE_CODEX_BIN_SOFT = RESOLVE_CODEX_BIN_LINES.join('; ')
