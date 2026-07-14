export interface ShellCommandDisplay {
  name: 'Bash' | 'PowerShell' | 'Shell'
  innerCmd: string
}

/** Remove provider-added shell wrappers from commands shown in the UI. */
export function parseShellCommand(raw: string): ShellCommandDisplay {
  const bash = raw.match(/^(?:\/bin\/bash|bash)\s+-lc\s+([\s\S]+)$/)
  if (bash) return { name: 'Bash', innerCmd: unwrapShellArgument(bash[1]) }

  const invocation = raw.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/)
  if (invocation) {
    const executable = invocation[1] ?? invocation[2] ?? invocation[3]
    const executableName = executable.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase()
    if (executableName === 'pwsh.exe' || executableName === 'pwsh' || executableName === 'powershell.exe' || executableName === 'powershell') {
      const command = invocation[4].match(/(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i)
      if (command) return { name: 'PowerShell', innerCmd: unwrapShellArgument(command[1]) }
    }
  }

  return { name: 'Shell', innerCmd: raw }
}

/** Reinterpret a legacy generic Shell tool call using its command payload. */
export function normalizeShellToolPresentation(toolName: string, command: unknown): ShellCommandDisplay | null {
  if (toolName.toLowerCase() !== 'shell' || typeof command !== 'string') return null
  const parsed = parseShellCommand(command)
  return parsed.name === 'Shell' ? null : parsed
}

function unwrapShellArgument(value: string): string {
  const arg = value.trim()
  return arg.length >= 2 &&
    ((arg[0] === '"' && arg[arg.length - 1] === '"') ||
      (arg[0] === "'" && arg[arg.length - 1] === "'"))
    ? arg.slice(1, -1)
    : arg
}
