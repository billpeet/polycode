/**
 * Provider dialect normalisation for tool calls.
 *
 * Drivers emit tool names in their provider's own vocabulary — Cursor sends
 * "Read file"/"Terminal" and a `kind` discriminator in metadata, Claude sends
 * "Read"/"Bash" directly. This maps them onto one canonical set so the UI can
 * switch on a single name.
 *
 * Longer term this belongs inside each Driver adapter, behind a discriminated
 * tool-call type on OutputEvent — at which point this function disappears.
 * Until then it is shared so desktop and mobile cannot drift.
 */
export function canonicalToolName(
  toolName: string,
  metadata?: Record<string, unknown> | null,
): string {
  const lower = toolName.toLowerCase()
  const kind = typeof metadata?.kind === 'string' ? metadata.kind.toLowerCase() : ''
  if (lower === 'grep' || kind === 'search') return 'Grep'
  if (lower === 'read file' || kind === 'read') return 'Read'
  if (lower === 'edit file' || kind === 'edit') return 'Edit'
  if (lower === 'bash') return 'Bash'
  if (lower === 'terminal' || kind === 'execute') return 'Bash'
  return toolName
}
