import type {
  Message,
  ModelOption,
  PermissionMode,
  PermissionRequest,
  Project,
  Question,
  QuestionAnswerValue,
  ReasoningLevel,
  RepoLocation,
  SendOptions,
  Session,
  SlashCommand,
  Thread,
} from '@polycode/shared'
import { rpcRequest, type HostConnection } from './client'

/**
 * The subset of CONTROL_RPC_CHANNELS the mobile app uses, typed to mirror the
 * desktop WindowApi signatures (apps/desktop/src/renderer/src/types/ipc.ts).
 * Each entry is [argsTuple, returnType].
 */
export interface RpcChannelMap {
  'projects:list': [[], Project[]]
  'locations:list': [[projectId: string], RepoLocation[]]

  'threads:list': [[projectId: string], Thread[]]
  'threads:create': [[projectId: string, name: string, locationId: string], Thread]
  'threads:delete': [[id: string], void]
  'threads:archive': [[id: string], 'archived' | 'deleted']
  'threads:unarchive': [[id: string], void]
  'threads:archivedCount': [[projectId: string], number]
  'threads:listArchived': [[projectId: string, limit?: number, offset?: number], Thread[]]
  'threads:updateName': [[id: string, name: string], void]
  'threads:updateProviderAndModel': [[id: string, provider: string, model: string], void]
  'threads:updateReasoningLevel': [[id: string, reasoningLevel: ReasoningLevel], void]
  'threads:setUnread': [[threadId: string, unread: boolean], void]
  'threads:setPermissionMode': [[threadId: string, permissionMode: PermissionMode], void]
  'threads:start': [[threadId: string], void]
  'threads:stop': [[threadId: string], void]
  'threads:reset': [[threadId: string], void]
  'threads:send': [[threadId: string, content: string, options?: SendOptions], void]
  'threads:approvePlan': [[threadId: string], void]
  'threads:rejectPlan': [[threadId: string], void]
  'threads:executePlanInNewContext': [[threadId: string], void]
  'threads:getQuestions': [[threadId: string], Question[]]
  'threads:answerQuestion': [
    [
      threadId: string,
      answers: Record<string, QuestionAnswerValue>,
      questionComments: Record<string, string>,
      generalComment: string,
    ],
    void,
  ]
  'threads:getPendingPermissions': [[threadId: string], PermissionRequest[]]
  'threads:approvePermissions': [[threadId: string, requestId?: string], void]
  'threads:denyPermissions': [[threadId: string, requestId?: string], void]

  'sessions:list': [[threadId: string], Session[]]
  'sessions:getActive': [[threadId: string], Session | null]

  'messages:list': [[threadId: string], Message[]]
  'messages:listBySession': [[sessionId: string], Message[]]

  'slash-commands:list': [[projectId?: string | null], SlashCommand[]]

  'models:claudeAvailable': [[threadId?: string], ModelOption[]]
  'models:codexAvailable': [[threadId?: string], ModelOption[]]
  'models:opencodeAvailable': [[threadId?: string], ModelOption[]]
  'models:piAvailable': [[threadId?: string], ModelOption[]]
  'models:cursorAvailable': [[threadId?: string], ModelOption[]]
}

export type RpcChannel = keyof RpcChannelMap

/** Typed RPC call against a specific host. */
export function rpc<C extends RpcChannel>(
  host: HostConnection,
  channel: C,
  ...args: RpcChannelMap[C][0]
): Promise<RpcChannelMap[C][1]> {
  return rpcRequest(host, channel, args) as Promise<RpcChannelMap[C][1]>
}
