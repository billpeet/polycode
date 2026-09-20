import { AzureDevOpsSettingsPanel } from './AzureDevOpsSettingsPanel'
import { useEffect, useState } from 'react'
import type { AppProfile } from '@polycode/shared'
import { SeedProductionPanel } from './SeedProductionPanel'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { CliHealthPanel } from './CliHealthDialog'
import { SlashCommandsPanel } from './SlashCommandsDialog'
import { YouTrackSettingsPanel } from './YouTrackSettingsDialog'
import { WebhookPanel } from './WebhookPanel'
import { RemoteControlPanel } from './RemoteControlPanel'
import { client, type ClientCapabilities } from '../lib/client'

type Tab = 'azure' | 'health' | 'slash' | 'youtrack' | 'webhook' | 'remote' | 'seed'

/** Tabs that configure the host process itself only exist where that process is attached. */
const TABS: { id: Tab; label: string; requires?: keyof ClientCapabilities }[] = [
  { id: 'health', label: 'Health Checks' },
  { id: 'slash', label: 'Slash Commands' },
  { id: 'azure', label: 'Azure DevOps' },
  { id: 'youtrack', label: 'YouTrack' },
  { id: 'webhook', label: 'Webhook', requires: 'webhook' },
  { id: 'remote', label: 'Remote', requires: 'remoteHosts' },
]

interface Props {
  projectId: string | null
  projectName?: string
  onClose: () => void
}

export default function SettingsDialog({ projectId, projectName, onClose }: Props) {
  const backdropClose = useBackdropClose(onClose)
  const [activeTab, setActiveTab] = useState<Tab>('health')
  const [profile, setProfile] = useState<AppProfile | null>(null)
  useEffect(() => {
    if (!client.capabilities.nativeDialogs) return
    let cancelled = false
    void client.invoke('app:profile').then((value) => { if (!cancelled) setProfile(value) })
      .catch((error: unknown) => console.error('[settings] Failed to read profile', error))
    return () => { cancelled = true }
  }, [])
  const tabs = TABS.filter((tab) => !tab.requires || client.capabilities[tab.requires])
  if (profile?.isDevelopment) tabs.push({ id: 'seed', label: 'Seed production DB' })

  async function openLogsFolder(): Promise<void> {
    try {
      const result = await client.invoke('app:open-logs-folder')
      if (typeof result === 'string' && result.trim()) {
        throw new Error(result)
      }
    } catch (error) {
      console.error('[settings] Failed to open logs folder', error)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className={`flex rounded-xl shadow-2xl overflow-hidden max-w-[calc(100vw-32px)] max-h-[calc(100vh-32px)] ${activeTab === 'seed' ? 'w-[840px] h-[680px]' : 'w-[640px] h-[520px]'}`}
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
          {tabs.map((tab) => (
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
            {client.capabilities.shell && (
              <button
                onClick={() => void openLogsFolder()}
                className="rounded px-2.5 py-1 text-xs mr-2 transition-colors hover:opacity-90"
                style={{
                  color: 'var(--color-text)',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                }}
                title="Open the folder containing PolyCode app logs"
              >
                Open Logs Folder
              </button>
            )}
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
            {activeTab === 'azure' && <AzureDevOpsSettingsPanel />}
            {activeTab === 'youtrack' && <YouTrackSettingsPanel hideHeader />}
            {activeTab === 'webhook' && <WebhookPanel hideHeader />}
            {activeTab === 'remote' && <RemoteControlPanel hideHeader />}
            {activeTab === 'seed' && profile?.isDevelopment && <SeedProductionPanel profile={profile} />}
          </div>
        </div>
      </div>
    </div>
  )
}
