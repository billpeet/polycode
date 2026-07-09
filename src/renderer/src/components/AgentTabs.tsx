import { useMemo } from 'react'
import { useMessageStore } from '../stores/messages'
import { useThreadStore } from '../stores/threads'
import { Message } from '../types/ipc'
import { groupByAgent, collectActiveAgents, findAgentGroup, AgentGroup } from './MessageStream'

interface Props {
  threadId: string
  sessionId?: string
  isolatedAgentKey: string | null
  onSelect: (agentKey: string | null) => void
}

const EMPTY: Message[] = []

export default function AgentTabs({ threadId, sessionId, isolatedAgentKey, onSelect }: Props) {
  const sessionMessages = useMessageStore((s) => (sessionId ? s.messagesBySession[sessionId] : undefined))
  const threadMessages = useMessageStore((s) => s.messagesByThread[threadId])
  const messages = sessionMessages ?? threadMessages ?? EMPTY
  const status = useThreadStore((s) => s.statusMap[threadId] ?? 'idle')

  const { activeAgents, isolatedAgent } = useMemo(() => {
    const entries = groupByAgent(messages)
    return {
      activeAgents: status === 'running' ? collectActiveAgents(entries) : [],
      isolatedAgent: isolatedAgentKey ? findAgentGroup(entries, isolatedAgentKey) : null,
    }
  }, [messages, status, isolatedAgentKey])

  // Show the isolated agent's tab even after it finishes (so there's always a way back
  // to Main), plus any running agents while the turn is live.
  const agentTabs: AgentGroup[] = [...activeAgents]
  if (isolatedAgent && !agentTabs.some((a) => a.key === isolatedAgent.key)) {
    agentTabs.push(isolatedAgent)
  }

  // Nothing to show: no running agents and no active isolation.
  if (agentTabs.length === 0) {
    return null
  }

  const tabs: { key: string | null; label: string; title?: string; spinner: boolean }[] = [
    { key: null, label: 'Main', spinner: false },
    ...agentTabs.map((agent) => ({
      key: agent.key,
      label: agent.label,
      title: agent.description,
      spinner: agent.status === 'running',
    })),
  ]

  return (
    <div
      className="flex items-center gap-1 px-4 py-2 overflow-x-auto"
      style={{
        borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      {tabs.map((tab) => {
        const isActive = (tab.key ?? null) === (isolatedAgentKey ?? null)
        return (
          <button
            key={tab.key ?? '__main__'}
            onClick={() => {
              if (!isActive) onSelect(tab.key)
            }}
            title={tab.title}
            className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5"
            style={{
              background: isActive ? 'rgba(232, 123, 95, 0.15)' : 'transparent',
              color: isActive ? 'var(--color-claude)' : 'var(--color-text-muted)',
              border: `1px solid ${isActive ? 'rgba(232, 123, 95, 0.3)' : 'var(--color-border)'}`,
            }}
          >
            {tab.spinner && (
              <span className="status-spinner" style={{ width: '0.6rem', height: '0.6rem', flexShrink: 0, borderTopColor: 'var(--color-claude)' }} />
            )}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
