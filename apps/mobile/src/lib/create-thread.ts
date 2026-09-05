import type { PermissionMode, Thread } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { newClientMessageId, saveAttachments, type PendingImage } from '@/lib/attachments'
import { requireConnection } from '@/stores/hosts'
import { useMessagesStore } from '@/stores/messages'
import { useProjectsStore } from '@/stores/projects'
import { useThreadsStore } from '@/stores/threads'
import type { Favourite } from '@/stores/favourites'

export type LocationChoice =
  | { kind: 'existing'; id: string }
  | { kind: 'new-worktree'; parentId: string; label: string }

/** Everything the New-thread sheet collects before "Start thread". */
export interface ThreadDraft {
  projectId: string
  location: LocationChoice
  agent: Favourite
  permissionMode: PermissionMode
  planMode: boolean
  message: string
  attachments: PendingImage[]
}

export interface StartThreadResult {
  thread: Thread
  /** Set when the thread was created but the first message failed to send. */
  sendError?: unknown
}

/**
 * Creates a thread from a draft and sends its first message.
 *
 * Unlike the desktop's create-on-send draft, mobile creates on "Start thread"
 * — but the name still stays `'New thread'` until the provider auto-titles it,
 * so both clients converge on the same row. Settings are only written when
 * they differ from what `threads:create` produced, to avoid three no-op RPCs.
 */
export async function startThread(draft: ThreadDraft): Promise<StartThreadResult> {
  const threads = useThreadsStore.getState()

  let locationId: string
  if (draft.location.kind === 'new-worktree') {
    const worktree = await rpc(
      requireConnection(),
      'locations:createWorktree',
      draft.location.parentId,
      draft.location.label.trim() || null,
    )
    await useProjectsStore.getState().fetchLocations(draft.projectId)
    locationId = worktree.id
  } else {
    locationId = draft.location.id
  }

  const thread = await threads.create(draft.projectId, 'New thread', locationId)

  if (thread.provider !== draft.agent.provider || thread.model !== draft.agent.model) {
    await threads.updateProviderAndModel(draft.projectId, thread.id, draft.agent.provider, draft.agent.model)
  }
  if (thread.reasoning_level !== draft.agent.reasoningLevel) {
    await threads.updateReasoningLevel(thread.id, draft.agent.reasoningLevel)
  }
  if (thread.permission_mode !== draft.permissionMode) {
    await threads.setPermissionMode(draft.projectId, thread.id, draft.permissionMode)
  }

  try {
    const { content, attachments } = await saveAttachments(thread.id, draft.message.trim(), draft.attachments)
    const clientUserMessageId = newClientMessageId()
    useMessagesStore.getState().appendUserMessage(thread.id, content, clientUserMessageId)
    await threads.send(thread.id, content, {
      ...(draft.planMode ? { planMode: true } : {}),
      clientUserMessageId,
      attachments,
    })
  } catch (sendError) {
    void threads.fetchQueue()
    return { thread, sendError }
  }

  void threads.fetchQueue()
  return { thread }
}
