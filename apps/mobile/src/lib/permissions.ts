import type { PermissionMode } from '@polycode/shared'

export interface PermissionOption {
  mode: PermissionMode
  label: string
  description: string
}

/**
 * Permission modes a provider actually honours, mirroring the desktop
 * composer (`ComposerToolbar.tsx`). Offering `workspace` to Claude or `auto`
 * to Codex would be a no-op the user could not tell from a real setting.
 * Pi has no desktop options; on mobile it gets the generic Ask/Yolo pair.
 */
export function permissionOptionsForProvider(provider: string): PermissionOption[] {
  if (provider === 'codex') {
    return [
      { mode: 'ask', label: 'Ask', description: 'Review writes and privileged actions before Codex runs them' },
      { mode: 'workspace', label: 'Workspace', description: 'Allow Codex to edit files in the workspace without asking' },
      { mode: 'yolo', label: 'YOLO', description: 'Bypass Codex approvals and sandbox' },
    ]
  }
  if (provider === 'claude-code') {
    return [
      { mode: 'ask', label: 'Ask', description: 'Ask before privileged Claude actions' },
      { mode: 'auto', label: 'Auto', description: 'Claude auto-approves routine actions; anything unusual still asks' },
      { mode: 'yolo', label: 'YOLO', description: 'Bypass Claude approval checks entirely' },
    ]
  }
  if (provider === 'opencode') {
    return [
      { mode: 'ask', label: 'Ask', description: 'Use the permissions configured in OpenCode' },
      { mode: 'yolo', label: 'YOLO', description: 'Auto-approve OpenCode permission requests' },
    ]
  }
  return [
    { mode: 'ask', label: 'Ask', description: 'Ask before privileged provider actions' },
    { mode: 'yolo', label: 'YOLO', description: 'Bypass provider approval checks where supported' },
  ]
}
