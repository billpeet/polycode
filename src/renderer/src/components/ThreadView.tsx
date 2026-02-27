import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { useLocationStore } from '../stores/locations'
import { useToastStore } from '../stores/toast'
import { useRateLimitStore } from '../stores/rateLimits'
import { useTodoStore, Todo } from '../stores/todos'
import { useSessionStore } from '../stores/sessions'
import { useGitStore } from '../stores/git'
import { OutputEvent, Message, ThreadStatus } from '../types/ipc'
import ThreadHeader from './ThreadHeader'

/** Look up the location path for a thread from store state (for use in callbacks) */
function getLocationPathForThread(threadId: string): string | null {
  const thread = Object.values(useThreadStore.getState().byProject)
    .flat()
    .find((t) => t.id === threadId)
  if (!thread?.location_id) return null
  const loc = Object.values(useLocationStore.getState().byProject)
    .flat()
    .find((l) => l.id === thread.location_id)
  return loc?.path ?? null
}
import SessionTabs from './SessionTabs'
import MessageStream from './MessageStream'
import InputBar from './InputBar'

function buildMessageContext(messages: Message[]): string {
  const userMsgs = messages.filter((m) => m.role === 'user')
  const lastAssistantMsg = [...messages].reverse().find((m) => {
    if (m.role !== 'assistant') return false
    if (!m.metadata) return true
    try {
      const meta = JSON.parse(m.metadata) as { type?: string }
      return meta.type !== 'tool_call' && meta.type !== 'tool_result'
    } catch {
      return true
    }
  })

  const parts: string[] = []
  if (userMsgs.length > 0) {
    parts.push('## User Request')
    for (const msg of userMsgs) {
      parts.push(msg.content.slice(0, 600))
    }
  }
  if (lastAssistantMsg) {
    parts.push('## Agent Summary')
    parts.push(lastAssistantMsg.content.slice(0, 1000))
  }
  return parts.join('\n\n')
}

interface Props {
  threadId: string
}

export default function ThreadView({ threadId }: Props) {
  const fetchMessages = useMessageStore((s) => s.fetch)
  const fetchMessagesBySession = useMessageStore((s) => s.fetchBySession)
  const appendEvent = useMessageStore((s) => s.appendEvent)
  const appendEventToSession = useMessageStore((s) => s.appendEventToSession)
  const setStatus = useThreadStore((s) => s.setStatus)
  const setName = useThreadStore((s) => s.setName)

  const fetchSessions = useSessionStore((s) => s.fetch)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const activeSessionId = useSessionStore((s) => s.activeSessionByThread[threadId])

  const cleanupRef = useRef<Array<() => void>>([])

  // Fetch sessions when thread changes
  useEffect(() => {
    fetchSessions(threadId)
  }, [threadId, fetchSessions])

  // Fetch messages when active session changes, and sync todos from persisted messages
  useEffect(() => {
    const doFetch = async () => {
      if (activeSessionId) {
        await fetchMessagesBySession(activeSessionId)
        const msgs = useMessageStore.getState().messagesBySession[activeSessionId] ?? []
        useTodoStore.getState().syncFromMessages(threadId, msgs)
      } else {
        await fetchMessages(threadId)
        const msgs = useMessageStore.getState().messagesByThread[threadId] ?? []
        useTodoStore.getState().syncFromMessages(threadId, msgs)
      }
    }
    doFetch()
  }, [threadId, activeSessionId, fetchMessages, fetchMessagesBySession])

  useEffect(() => {
    // Subscribe to streaming events
    const unsubOutput = window.api.on(`thread:output:${threadId}`, (...args) => {
      const event = args[0] as OutputEvent
      const currentActiveSession = useSessionStore.getState().activeSessionByThread[threadId]

      // Route event to session-based store if we have an active session and event matches
      if (event.sessionId && currentActiveSession && event.sessionId === currentActiveSession) {
        appendEventToSession(event.sessionId, threadId, event)
      } else {
        appendEvent(threadId, event)
      }

      // Intercept TodoWrite tool calls and update the todo store
      if (event.type === 'tool_call' && event.metadata?.name === 'TodoWrite') {
        const input = event.metadata.input as { todos?: Todo[] } | undefined
        if (Array.isArray(input?.todos)) {
          useTodoStore.getState().setTodos(threadId, input.todos as Todo[])
        }
      }

      // Accumulate token usage
      if (event.type === 'usage' && event.metadata) {
        const input = (event.metadata.input_tokens as number) ?? 0
        const output = (event.metadata.output_tokens as number) ?? 0
        if (input || output) {
          useThreadStore.getState().addUsage(threadId, input, output, input)
        }
      }

      if (event.type === 'error') {
        useToastStore.getState().add({ type: 'error', message: event.content, duration: 0 })
      }

      if (event.type === 'rate_limit' && event.metadata) {
        const info = event.metadata as { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number }
        const threadState = useThreadStore.getState()
        const currentThread = Object.values(threadState.byProject).flat().find((t) => t.id === threadId)
        const provider = currentThread?.provider ?? 'claude-code'
        useRateLimitStore.getState().setLimit(threadId, provider, info)
      }
    })

    const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
      const status = args[0] as 'idle' | 'running' | 'stopping' | 'error' | 'stopped'
      setStatus(threadId, status)
      if (status === 'error') {
        useToastStore.getState().add({
          type: 'error',
          message: 'Session error — try sending a new message to restart.',
          duration: 0,
        })
      }
    })

    const unsubComplete = window.api.on(`thread:complete:${threadId}`, (...args) => {
      // Use the status sent directly with the complete event to avoid race conditions
      // with the separate thread:status IPC event
      const completionStatus = (args[0] as ThreadStatus | undefined) ?? 'idle'

      // Ensure the store reflects the final status (handles cases where the
      // thread:status event hasn't been processed yet)
      setStatus(threadId, completionStatus)

      // Clear todos on completion — Claude Code often leaves stale todo lists hanging
      useTodoStore.getState().clearTodos(threadId)

      // Re-fetch messages after completion to replace optimistic entries with persisted ones
      const currentActiveSession = useSessionStore.getState().activeSessionByThread[threadId]
      if (currentActiveSession) {
        useMessageStore.getState().fetchBySession(currentActiveSession)
      } else {
        fetchMessages(threadId)
      }

      // Re-fetch sessions in case a new one was created
      fetchSessions(threadId)

      // Refresh modified files for the git staging feature
      useGitStore.getState().fetchModifiedFiles(threadId)

      // Auto-generate commit message when run completes successfully and field is empty
      if (completionStatus === 'idle') {
        const locationPath = getLocationPathForThread(threadId)
        if (locationPath) {
          const currentMsg = useGitStore.getState().commitMessageByPath[locationPath] ?? ''
          if (!currentMsg.trim()) {
            const activeSession = useSessionStore.getState().activeSessionByThread[threadId]
            const msgs = activeSession
              ? (useMessageStore.getState().messagesBySession[activeSession] ?? [])
              : (useMessageStore.getState().messagesByThread[threadId] ?? [])
            const modifiedFiles = useGitStore.getState().modifiedFilesByThread[threadId] ?? []
            const context = buildMessageContext(msgs)
            useGitStore.getState().generateCommitMessageWithContext(locationPath, modifiedFiles, context)
          }
        }
      }

      // Check for queued message and auto-send if session completed successfully
      const queuedMessage = useThreadStore.getState().queuedMessageByThread[threadId]

      // Only auto-send when status is idle (not error/stopped/plan_pending/question_pending)
      if (queuedMessage && completionStatus === 'idle') {
        // Clear queue first to prevent double-send
        useThreadStore.getState().clearQueue(threadId)

        // Append optimistic user message to the correct store based on active session
        const activeSession = useSessionStore.getState().activeSessionByThread[threadId]
        if (activeSession) {
          useMessageStore.getState().appendUserMessageToSession(activeSession, threadId, queuedMessage.content)
        } else {
          useMessageStore.getState().appendUserMessage(threadId, queuedMessage.content)
        }

        useThreadStore.getState().send(
          threadId,
          queuedMessage.content,
          { planMode: queuedMessage.planMode }
        )
        // Skip completion toast since we're continuing with queued message
        return
      }

      // Notify only when the user isn't currently viewing this thread
      const selectedId = useThreadStore.getState().selectedThreadId
      if (selectedId !== threadId) {
        const byProject = useThreadStore.getState().byProject
        let threadName = 'Thread'
        for (const threads of Object.values(byProject)) {
          const found = threads.find((t) => t.id === threadId)
          if (found) { threadName = found.name; break }
        }
        useToastStore.getState().add({
          type: 'success',
          message: `✓ ${threadName} completed`,
          duration: 4000,
        })
      }
    })

    const unsubTitle = window.api.on(`thread:title:${threadId}`, (...args) => {
      setName(threadId, args[0] as string)
    })

    // Subscribe to session switch events from main process
    const unsubSessionSwitch = window.api.on(`thread:session-switched:${threadId}`, (...args) => {
      const sessionId = args[0] as string
      setActiveSession(threadId, sessionId)
      // Refetch sessions to update the tabs (a new session may have been created)
      useSessionStore.getState().fetch(threadId)
    })

    const unsubPid = window.api.on(`thread:pid:${threadId}`, (...args) => {
      useThreadStore.getState().setPid(threadId, (args[0] as number | null) ?? null)
    })

    cleanupRef.current = [unsubOutput, unsubStatus, unsubComplete, unsubTitle, unsubSessionSwitch, unsubPid]

    return () => {
      cleanupRef.current.forEach((fn) => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  return (
    <div className="relative flex flex-1 flex-col h-full overflow-hidden">
      <ThreadHeader threadId={threadId} />
      <SessionTabs threadId={threadId} />
      <MessageStream threadId={threadId} sessionId={activeSessionId} />
      <InputBar threadId={threadId} />
    </div>
  )
}
