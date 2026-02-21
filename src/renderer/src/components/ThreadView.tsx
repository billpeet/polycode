import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { useProjectStore } from '../stores/projects'
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
  const rename = useThreadStore((s) => s.rename)

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
    })

    const unsubStatus = window.api.on(`thread:status:${threadId}`, (...args) => {
      const status = args[0] as 'idle' | 'running' | 'error' | 'stopped'
      setStatus(threadId, status)
    })

    const unsubComplete = window.api.on(`thread:complete:${threadId}`, () => {
      // Re-fetch messages after completion to replace optimistic entries with persisted ones
      fetchMessages(threadId)
    })

    const unsubTitle = window.api.on(`thread:title:${threadId}`, (...args) => {
      rename(threadId, args[0] as string)
    })

    cleanupRef.current = [unsubOutput, unsubStatus, unsubComplete, unsubTitle]

    return () => {
      cleanupRef.current.forEach((fn) => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden">
      <ThreadHeader threadId={threadId} />
      <MessageStream threadId={threadId} />
      <InputBar threadId={threadId} />
    </div>
  )
}
