import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'
import { useToastStore } from '../stores/toast'
import { useTodoStore, Todo } from '../stores/todos'
import { useSessionStore } from '../stores/sessions'
import { useGitStore } from '../stores/git'
import { OutputEvent } from '../types/ipc'
import ThreadHeader from './ThreadHeader'
import SessionTabs from './SessionTabs'
import MessageStream from './MessageStream'
import InputBar from './InputBar'

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

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const cleanupRef = useRef<Array<() => void>>([])

  // Fetch sessions when thread changes
  useEffect(() => {
    fetchSessions(threadId)
  }, [threadId, fetchSessions])

  // Fetch messages when active session changes
  useEffect(() => {
    if (activeSessionId) {
      fetchMessagesBySession(activeSessionId)
    } else {
      // Fallback to thread-based fetch for threads without sessions
      fetchMessages(threadId)
    }
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

      if (event.type === 'error') {
        useToastStore.getState().add({ type: 'error', message: event.content, duration: 0 })
      }
    })

    const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
      const status = args[0] as 'idle' | 'running' | 'error' | 'stopped'
      setStatus(threadId, status)
      if (status === 'error') {
        useToastStore.getState().add({
          type: 'error',
          message: 'Session error — try sending a new message to restart.',
          duration: 0,
        })
      }
    })

    const unsubComplete = window.api.on(`thread:complete:${threadId}`, () => {
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
      if (project?.path) {
        useGitStore.getState().fetchModifiedFiles(threadId, project.path)
      }

      // Safety net: ensure status is reset if still running (handles edge cases where status event was missed)
      const currentStatus = useThreadStore.getState().statusMap[threadId]
      if (currentStatus === 'running') {
        setStatus(threadId, 'idle')
      }

      // Check for queued message and auto-send if session completed successfully
      const queuedMessage = useThreadStore.getState().queuedMessageByThread[threadId]
      const finalStatus = useThreadStore.getState().statusMap[threadId]

      // Only auto-send when status is idle (not error/stopped/plan_pending/question_pending)
      if (queuedMessage && finalStatus === 'idle') {
        // Clear queue first to prevent double-send
        useThreadStore.getState().clearQueue(threadId)

        // Append optimistic user message to the correct store based on active session
        const activeSession = useSessionStore.getState().activeSessionByThread[threadId]
        if (activeSession) {
          useMessageStore.getState().appendUserMessageToSession(activeSession, threadId, queuedMessage.content)
        } else {
          useMessageStore.getState().appendUserMessage(threadId, queuedMessage.content)
        }

        // Get project for working dir
        const projectsState = useProjectStore.getState()
        const currentProject = projectsState.projects.find(
          (p) => p.id === projectsState.selectedProjectId
        )

        if (currentProject) {
          useThreadStore.getState().send(
            threadId,
            queuedMessage.content,
            currentProject.path,
            { planMode: queuedMessage.planMode }
          )
        }
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

    cleanupRef.current = [unsubOutput, unsubStatus, unsubComplete, unsubTitle, unsubSessionSwitch]

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
