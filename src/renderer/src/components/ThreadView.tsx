import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'
import { useToastStore } from '../stores/toast'
import { useTodoStore, Todo } from '../stores/todos'
import { useUiStore } from '../stores/ui'
import { OutputEvent } from '../types/ipc'
import ThreadHeader from './ThreadHeader'
import MessageStream from './MessageStream'
import InputBar from './InputBar'

interface Props {
  threadId: string
}

export default function ThreadView({ threadId }: Props) {
  const fetchMessages = useMessageStore((s) => s.fetch)
  const appendEvent = useMessageStore((s) => s.appendEvent)
  const setStatus = useThreadStore((s) => s.setStatus)
  const setName = useThreadStore((s) => s.setName)

  const projects = useProjectStore((s) => s.projects)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const project = projects.find((p) => p.id === selectedProjectId)

  const cleanupRef = useRef<Array<() => void>>([])

  useEffect(() => {
    fetchMessages(threadId)

    // Subscribe to streaming events
    const unsubOutput = window.api.on(`thread:output:${threadId}`, (...args) => {
      const event = args[0] as OutputEvent
      appendEvent(threadId, event)

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
      fetchMessages(threadId)

      // Safety net: ensure status is reset if still running (handles edge cases where status event was missed)
      const currentStatus = useThreadStore.getState().statusMap[threadId]
      if (currentStatus === 'running') {
        setStatus(threadId, 'idle')
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

    cleanupRef.current = [unsubOutput, unsubStatus, unsubComplete, unsubTitle]

    return () => {
      cleanupRef.current.forEach((fn) => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  return (
    <div className="relative flex flex-1 flex-col h-full overflow-hidden">
      <ThreadHeader threadId={threadId} />
      <MessageStream threadId={threadId} />
      <InputBar threadId={threadId} />
    </div>
  )
}
