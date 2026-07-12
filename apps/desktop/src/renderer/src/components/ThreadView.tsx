import { useEffect, useRef, useState } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { useToastStore } from '../stores/toast'
import { useRateLimitStore } from '../stores/rateLimits'
import { useTodoStore, Todo } from '../stores/todos'
import { useSessionStore } from '../stores/sessions'
import { useGitStore } from '../stores/git'
import { OutputEvent, ThreadStatus } from '../types/ipc'
import ThreadHeader from './ThreadHeader'
import SessionTabs from './SessionTabs'
import AgentTabs from './AgentTabs'
import MessageStream from './MessageStream'
import InputBar from './InputBar'
import { formatErrorDetails } from '../lib/errorDetails'

interface Props {
  threadId: string
}

function formatThreadEventErrorDetails(event: OutputEvent, threadId: string): string {
  return formatErrorDetails({
    action: 'thread:output',
    threadId,
    sessionId: event.sessionId ?? null,
    message: event.content,
    metadata: event.metadata ?? null,
  })
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

  // View isolation: null = full transcript with inline agent groups; otherwise the
  // key of a single AgentGroup to show in isolation (driven by AgentTabs / group headers).
  // Persists after the turn finishes so the isolated agent's tab (and the Main tab) stay
  // reachable; AgentTabs keeps a Main tab visible whenever an agent is isolated.
  const [isolatedAgentKey, setIsolatedAgentKey] = useState<string | null>(null)

  // Reset isolation only when the thread/session changes.
  useEffect(() => {
    setIsolatedAgentKey(null)
  }, [threadId, activeSessionId])
  const isPendingThread = useThreadStore((s) =>
    Object.values(s.byProject).some((threads) => (threads ?? []).some((thread) => thread.id === threadId && thread.is_pending))
  )

  const cleanupRef = useRef<Array<() => void>>([])

  // Fetch sessions when thread changes
  useEffect(() => {
    if (isPendingThread) return
    fetchSessions(threadId)
  }, [threadId, fetchSessions, isPendingThread])

  // Fetch messages when active session changes, and sync todos from persisted messages
  useEffect(() => {
    if (isPendingThread) return
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
  }, [threadId, activeSessionId, fetchMessages, fetchMessagesBySession, isPendingThread])

  useEffect(() => {
    if (isPendingThread) return
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

      // Intercept TodoWrite/todo_list/TaskCreate/TaskUpdate tool calls and update the todo store.
      // Only main-scope activity drives the thread's todo panel — sub-agent todo activity
      // is scoped to that sub-agent and must not overwrite the main thread's todos.
      if (event.metadata?.agent_scope !== 'subagent') {
        if (event.type === 'tool_call') {
          if (event.metadata?.name === 'TodoWrite') {
            const input = event.metadata.input as { todos?: Todo[] } | undefined
            if (Array.isArray(input?.todos)) {
              useTodoStore.getState().setTodos(threadId, input.todos as Todo[])
            }
          } else if (event.metadata?.name === 'TaskCreate') {
            useTodoStore.getState().addTask(threadId, (event.metadata.input as Record<string, unknown> | undefined) ?? {})
          } else if (event.metadata?.name === 'TaskUpdate') {
            const input = (event.metadata.input as Record<string, unknown> | undefined) ?? {}
            const taskId = typeof input.taskId === 'string' ? input.taskId : undefined
            const status = input.status as Todo['status'] | undefined
            if (taskId && (status === 'pending' || status === 'in_progress' || status === 'completed')) {
              useTodoStore.getState().updateTask(threadId, taskId, status)
            }
          } else if (event.content === 'todo_list') {
            const items = event.metadata?.items as { text: string; completed: boolean }[] | undefined
            if (Array.isArray(items)) {
              useTodoStore.getState().setTodos(
                threadId,
                items.map((item) => ({ content: item.text, activeForm: '', status: item.completed ? 'completed' : 'pending' }))
              )
            }
          }
        }
        // Codex todo_list result carries the final completed states
        if (event.type === 'tool_result') {
          const items = event.metadata?.items as { text: string; completed: boolean }[] | undefined
          if (Array.isArray(items) && items.length > 0 && typeof items[0].text === 'string') {
            useTodoStore.getState().setTodos(
              threadId,
              items.map((item) => ({ content: item.text, activeForm: '', status: item.completed ? 'completed' : 'pending' }))
            )
          }
        }
      }

      // Accumulate token usage
      if (event.type === 'usage' && event.metadata) {
        const input = (event.metadata.input_tokens as number) ?? 0
        const output = (event.metadata.output_tokens as number) ?? 0
        const contextWindow = (event.metadata.context_window as number | undefined) ?? null
        if (input || output || contextWindow) {
          useThreadStore.getState().addUsage(threadId, input, output, contextWindow)
        }
      }

      if (event.type === 'error') {
        useToastStore.getState().add({
          type: 'error',
          title: 'Thread Error',
          message: event.content || 'Thread failed with an unknown error',
          details: formatThreadEventErrorDetails(event, threadId),
          duration: 0,
        })
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
          title: 'Session Error',
          message: 'Session error — try sending a new message to restart.',
          details: formatErrorDetails({
            action: 'thread:status',
            threadId,
            status,
            suggestion: 'Try sending a new message to restart the session.',
          }),
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

      // Re-fetch messages after completion to replace optimistic entries with
      // persisted ones, then rebuild todo state from that canonical history.
      void (async () => {
        const currentActiveSession = useSessionStore.getState().activeSessionByThread[threadId]
        if (currentActiveSession) {
          await useMessageStore.getState().fetchBySession(currentActiveSession)
          const msgs = useMessageStore.getState().messagesBySession[currentActiveSession] ?? []
          useTodoStore.getState().syncFromMessages(threadId, msgs)
        } else {
          await fetchMessages(threadId)
          const msgs = useMessageStore.getState().messagesByThread[threadId] ?? []
          useTodoStore.getState().syncFromMessages(threadId, msgs)
        }
      })()

      // Re-fetch sessions in case a new one was created
      fetchSessions(threadId)

      // Refresh modified files for the git staging feature
      useGitStore.getState().fetchModifiedFiles(threadId)

      // Check for queued message and auto-send if session completed successfully
      const queuedMessage = useThreadStore.getState().queuedMessageByThread[threadId]

      // Only auto-send when status is idle (not error/stopped/plan_pending/question_pending)
      if (queuedMessage && completionStatus === 'idle') {
        // Clear queue first to prevent double-send
        useThreadStore.getState().clearQueue(threadId)

        // Append optimistic user message to the correct store based on active session
        const activeSession = useSessionStore.getState().activeSessionByThread[threadId]
        if (activeSession) {
          useMessageStore.getState().appendUserMessageToSession(activeSession, threadId, queuedMessage.content, queuedMessage.options.clientUserMessageId)
        } else {
          useMessageStore.getState().appendUserMessage(threadId, queuedMessage.content, queuedMessage.options.clientUserMessageId)
        }

        useThreadStore.getState().send(
          threadId,
          queuedMessage.content,
          queuedMessage.options
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
  }, [threadId, isPendingThread])

  return (
    <div className="relative flex flex-1 flex-col h-full overflow-hidden">
      <ThreadHeader threadId={threadId} />
      {!isPendingThread && <SessionTabs threadId={threadId} />}
      {!isPendingThread && (
        <AgentTabs
          threadId={threadId}
          sessionId={activeSessionId}
          isolatedAgentKey={isolatedAgentKey}
          onSelect={setIsolatedAgentKey}
        />
      )}
      <MessageStream
        threadId={threadId}
        sessionId={activeSessionId}
        agentFilter={isolatedAgentKey}
        onIsolateAgent={setIsolatedAgentKey}
      />
      <InputBar threadId={threadId} />
    </div>
  )
}
