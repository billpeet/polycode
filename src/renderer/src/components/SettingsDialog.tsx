import { useState } from 'react'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { CliHealthPanel } from './CliHealthDialog'
import { SlashCommandsPanel } from './SlashCommandsDialog'
import { YouTrackSettingsPanel } from './YouTrackSettingsDialog'
import { WebhookPanel } from './WebhookPanel'

type Tab = 'health' | 'slash' | 'youtrack' | 'webhook'

const TABS: { id: Tab; label: string }[] = [
  { id: 'health', label: 'Health Checks' },
  { id: 'slash', label: 'Slash Commands' },
  { id: 'youtrack', label: 'YouTrack' },
  { id: 'webhook', label: 'Webhook' },
]

interface Props {
  projectId: string | null
  projectName?: string
  onClose: () => void
}

export default function SettingsDialog({ projectId, projectName, onClose }: Props) {
  const backdropClose = useBackdropClose(onClose)
  const [activeTab, setActiveTab] = useState<Tab>('health')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className="flex w-[640px] h-[520px] rounded-xl shadow-2xl overflow-hidden"
        style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <div
          className="flex flex-col w-[160px] flex-shrink-0 py-3"
          style={{ background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)' }}
        >
          <h2
            className="px-4 pb-3 text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Settings
          </h2>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center px-4 py-1.5 text-xs text-left transition-colors"
              style={{
                background: activeTab === tab.id ? 'var(--color-surface-2)' : 'transparent',
                color: activeTab === tab.id ? 'var(--color-text)' : 'var(--color-text-muted)',
                borderLeft: activeTab === tab.id ? '2px solid var(--color-claude)' : '2px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0 p-5 overflow-hidden">
          {/* Close button */}
          <div className="flex justify-end mb-2 flex-shrink-0">
            <button
              onClick={onClose}
              className="rounded p-1 text-xs opacity-50 hover:opacity-100 transition-opacity"
              style={{ color: 'var(--color-text-muted)' }}
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {activeTab === 'health' && <CliHealthPanel hideHeader />}
            {activeTab === 'slash' && (
              <SlashCommandsPanel projectId={projectId} projectName={projectName} hideHeader />
            )}
            {activeTab === 'youtrack' && <YouTrackSettingsPanel hideHeader />}
            {activeTab === 'webhook' && <WebhookPanel hideHeader />}
          </div>
        </div>
      </div>
    </div>
  )
}
