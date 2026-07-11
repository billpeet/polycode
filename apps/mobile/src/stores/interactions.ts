import { create } from 'zustand'
import type { PermissionRequest, Question, QuestionAnswerValue } from '@polycode/shared'
import { rpc } from '../api/rpc'
import { requireConnection } from './hosts'

/**
 * Pending interactive state per thread: permission requests, questions and
 * plan approval. Fetched when thread status enters *_pending (there is no
 * bubble event for these) and cleared when the interaction resolves.
 */
interface InteractionsState {
  permissionsByThread: Record<string, PermissionRequest[]>
  questionsByThread: Record<string, Question[]>

  fetchPermissions: (threadId: string) => Promise<void>
  approvePermission: (threadId: string, requestId?: string) => Promise<void>
  denyPermission: (threadId: string, requestId?: string) => Promise<void>

  fetchQuestions: (threadId: string) => Promise<void>
  answerQuestions: (
    threadId: string,
    answers: Record<string, QuestionAnswerValue>,
    questionComments: Record<string, string>,
    generalComment: string,
  ) => Promise<void>

  approvePlan: (threadId: string) => Promise<void>
  rejectPlan: (threadId: string) => Promise<void>
  executePlanInNewContext: (threadId: string) => Promise<void>

  clear: (threadId: string) => void
}

export const useInteractionsStore = create<InteractionsState>((set, get) => ({
  permissionsByThread: {},
  questionsByThread: {},

  fetchPermissions: async (threadId) => {
    const permissions = await rpc(requireConnection(), 'threads:getPendingPermissions', threadId)
    set((s) => ({ permissionsByThread: { ...s.permissionsByThread, [threadId]: permissions } }))
  },

  approvePermission: async (threadId, requestId) => {
    await rpc(requireConnection(), 'threads:approvePermissions', threadId, requestId)
    set((s) => ({
      permissionsByThread: {
        ...s.permissionsByThread,
        [threadId]: requestId
          ? (s.permissionsByThread[threadId] ?? []).filter((p) => p.requestId !== requestId)
          : [],
      },
    }))
  },

  denyPermission: async (threadId, requestId) => {
    await rpc(requireConnection(), 'threads:denyPermissions', threadId, requestId)
    set((s) => ({
      permissionsByThread: {
        ...s.permissionsByThread,
        [threadId]: requestId
          ? (s.permissionsByThread[threadId] ?? []).filter((p) => p.requestId !== requestId)
          : [],
      },
    }))
  },

  fetchQuestions: async (threadId) => {
    const questions = await rpc(requireConnection(), 'threads:getQuestions', threadId)
    set((s) => ({ questionsByThread: { ...s.questionsByThread, [threadId]: questions } }))
  },

  answerQuestions: async (threadId, answers, questionComments, generalComment) => {
    await rpc(requireConnection(), 'threads:answerQuestion', threadId, answers, questionComments, generalComment)
    set((s) => ({ questionsByThread: { ...s.questionsByThread, [threadId]: [] } }))
  },

  approvePlan: async (threadId) => {
    await rpc(requireConnection(), 'threads:approvePlan', threadId)
  },

  rejectPlan: async (threadId) => {
    await rpc(requireConnection(), 'threads:rejectPlan', threadId)
  },

  executePlanInNewContext: async (threadId) => {
    await rpc(requireConnection(), 'threads:executePlanInNewContext', threadId)
  },

  clear: (threadId) =>
    set((s) => {
      const permissions = { ...s.permissionsByThread }
      const questions = { ...s.questionsByThread }
      delete permissions[threadId]
      delete questions[threadId]
      return { permissionsByThread: permissions, questionsByThread: questions }
    }),
}))
