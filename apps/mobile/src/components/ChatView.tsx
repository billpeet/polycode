import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  DEFAULT_CONTEXT_LIMIT,
  MODEL_CONTEXT_LIMITS,
  PROVIDERS,
  getModelsForProvider,
  type Message,
  type OutputEvent,
  type PermissionMode,
  type Provider,
  type SlashCommand,
  type ThreadStatus,
} from '@polycode/shared'
import { channels, onChannel } from '@/api/events'
import { rpc } from '@/api/rpc'
import { sseManager } from '@/api/sse'
import { useHostsStore } from '@/stores/hosts'
import { PermissionBanner, PlanBanner, QuestionBanner } from '@/components/Banners'
import * as ImagePicker from 'expo-image-picker'
import { InputBar, type PendingImage } from '@/components/InputBar'
import { MessageList } from '@/components/MessageList'
import { PlanSheet } from '@/components/PlanSheet'
import { StatusDot } from '@/components/StatusDot'
import { SessionTabs } from '@/components/SessionTabs'
import { effortLabel } from '@/components/ThreadControls'
import { ThreadSettingsSheet } from '@/components/ThreadSettingsSheet'
import { TodoBadge, TodoSheet } from '@/components/TodoPanel'
import { Chip } from '@/components/ui'
import { ActionSheet } from '@/components/ActionSheet'
import { FileBrowser } from '@/components/FileBrowser'
import { GitPanel } from '@/components/GitPanel'
import { useInteractionsStore } from '@/stores/interactions'
import { useMessagesStore } from '@/stores/messages'
import { favouriteChipLabel, favouriteEquals, type Favourite } from '@/stores/favourites'
import { useFavouritesStore } from '@/stores/favourites'
import { usePlansStore } from '@/stores/plans'
import { useProjectsStore } from '@/stores/projects'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'
import { useThreadsStore } from '@/stores/threads'
import { useTodosStore } from '@/stores/todos'
import { colors, statusLabel } from '@/theme/colors'

const EMPTY_MESSAGES: Message[] = []

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`
  return String(count)
}

function modelLabel(provider: string, model: string): string {
  const options = getModelsForProvider(provider as Provider)
  return options.find((option) => option.id === model)?.label ?? model
}

function providerLabel(provider: string): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider
}

export function ChatView(props: { threadId: string; projectId: string; onOpenSidebar: () => void }) {
  const { threadId, projectId, onOpenSidebar } = props

  const thread = useThreadsStore((s) => s.findThread(threadId))
  const fetchThreads = useThreadsStore((s) => s.fetch)
  const sendMessage = useThreadsStore((s) => s.send)
  const stopThread = useThreadsStore((s) => s.stop)
  const setUnread = useThreadsStore((s) => s.setUnread)
  const setPermissionMode = useThreadsStore((s) => s.setPermissionMode)
  const updateProviderAndModel = useThreadsStore((s) => s.updateProviderAndModel)

  const messages = useMessagesStore((s) => s.messagesByThread[threadId] ?? EMPTY_MESSAGES)
  const usage = useMessagesStore((s) => s.usageByThread[threadId])
  const rateLimit = useMessagesStore((s) => s.rateLimitByThread[threadId])
  const fetchMessages = useMessagesStore((s) => s.fetch)
  const appendEvent = useMessagesStore((s) => s.appendEvent)
  const appendUserMessage = useMessagesStore((s) => s.appendUserMessage)

  const todos = useTodosStore((s) => s.todosByThread[threadId] ?? null)
  const applyTodoEvent = useTodosStore((s) => s.applyEvent)
  const syncTodos = useTodosStore((s) => s.syncFromMessages)

  const permissions = useInteractionsStore((s) => s.permissionsByThread[threadId] ?? null)
  const questions = useInteractionsStore((s) => s.questionsByThread[threadId] ?? null)
  const interactions = useInteractionsStore()

  const [showSettings, setShowSettings] = useState(false)
  const [showTodos, setShowTodos] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const favourites = useFavouritesStore((s) => s.favourites)
  const plan = usePlansStore((s) => s.planByThread[threadId] ?? null)

  // Plan pane: seed on open, follow live association/content updates.
  useEffect(() => {
    void usePlansStore.getState().fetch(threadId).catch(() => undefined)
    const offAssociated = onChannel(channels.planAssociated, (_channel, payload) => {
      const data = payload as { threadId?: string; name?: string; path?: string | null; content?: string }
      if (data?.threadId === threadId && typeof data.name === 'string') {
        usePlansStore.getState().setPlan(threadId, { name: data.name, path: data.path ?? null, content: data.content ?? null })
      }
    })
    const offChanged = onChannel(channels.planFileChanged, (_channel, payload) => {
      const data = payload as { name?: string; content?: string }
      if (typeof data?.name === 'string' && typeof data.content === 'string') {
        usePlansStore.getState().updateByName(data.name, data.content)
      }
    })
    return () => {
      offAssociated()
      offChanged()
    }
  }, [threadId])
  const [showGit, setShowGit] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [showThreadMenu, setShowThreadMenu] = useState(false)
  const [attachments, setAttachments] = useState<PendingImage[]>([])
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])

  // The thread's repo location path drives the git panel and file browser.
  // Only local locations are supported by the host-side git/files handlers.
  const location = useProjectsStore((s) =>
    thread?.location_id ? s.locationsByProject[projectId]?.find((l) => l.id === thread.location_id) : undefined,
  )
  const fetchLocations = useProjectsStore((s) => s.fetchLocations)
  useEffect(() => {
    void fetchLocations(projectId).catch(() => undefined)
  }, [projectId, fetchLocations])
  const repoPath = location?.path ?? null

  // Slash commands for the "/" popup (global + project scoped).
  useEffect(() => {
    const connection = useHostsStore.getState().activeConnection()
    if (!connection) return
    let cancelled = false
    rpc(connection, 'slash-commands:list', projectId)
      .then((commands) => {
        if (!cancelled) setSlashCommands(commands)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [projectId])
  const insets = useSafeAreaInsets()
  // Precise IME tracking (native inset animation via Reanimated) — the
  // Keyboard-event heights under-report on some edge-to-edge devices.
  const keyboard = useAnimatedKeyboard()
  const bottomInset = insets.bottom
  const keyboardPadStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(keyboard.height.value, bottomInset),
  }))

  const status: ThreadStatus = thread?.status ?? 'idle'

  const refetchAll = useCallback(() => {
    fetchMessages(threadId)
      .then((loaded) => syncTodos(threadId, loaded))
      .catch(() => {
        // Host unreachable — the SSE reconnect loop will trigger another refetch.
      })
  }, [threadId, fetchMessages, syncTodos])

  // Ensure the thread object exists (selection can be restored before lists load).
  useEffect(() => {
    if (!thread) void fetchThreads(projectId)
  }, [thread, projectId, fetchThreads])

  // Initial load + refetch on SSE reconnect (missed frames are not replayed).
  useEffect(() => {
    refetchAll()
    return sseManager.onConnect(refetchAll)
  }, [refetchAll])

  // Session tabs: load the list, follow active-session switches from any device.
  const fetchSessions = useSessionsStore((s) => s.fetch)
  useEffect(() => {
    void fetchSessions(threadId).catch(() => undefined)
    return onChannel(channels.threadSessionSwitched(threadId), () => {
      void fetchSessions(threadId).catch(() => undefined)
      refetchAll()
    })
  }, [threadId, fetchSessions, refetchAll])

  // Live event wiring for this thread.
  useEffect(() => {
    const offOutput = onChannel(channels.threadOutput(threadId), (_channel, rawEvent) => {
      const event = rawEvent as OutputEvent
      if (!event || typeof event.type !== 'string') return
      appendEvent(threadId, event)
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        applyTodoEvent(threadId, event)
      }
    })

    const offStatus = onChannel(channels.threadStatus(threadId), (_channel, rawStatus) => {
      const nextStatus = rawStatus as ThreadStatus
      if (nextStatus === 'permission_pending') void interactions.fetchPermissions(threadId)
      if (nextStatus === 'question_pending') void interactions.fetchQuestions(threadId)
    })

    const offComplete = onChannel(channels.threadComplete(threadId), () => {
      // Replace streamed bubbles with persisted rows once the turn finishes.
      refetchAll()
      interactions.clear(threadId)
      // Resets create new sessions; keep the tab strip current.
      void useSessionsStore.getState().fetch(threadId).catch(() => undefined)
    })

    return () => {
      offOutput()
      offStatus()
      offComplete()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  // Fetch pending interactions when we open a thread that is already waiting.
  useEffect(() => {
    if (status === 'permission_pending') void interactions.fetchPermissions(threadId)
    if (status === 'question_pending') void interactions.fetchQuestions(threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, status])

  // Clear unread once the thread is open.
  useEffect(() => {
    if (thread?.unread) void setUnread(projectId, threadId, false)
  }, [thread?.unread, projectId, threadId, setUnread])

  // Unknown models fall back to the default limit — never to the thread's own
  // current usage, which would always read as 100%.
  const contextLimit = useMemo(() => {
    if (!thread) return DEFAULT_CONTEXT_LIMIT
    return MODEL_CONTEXT_LIMITS[thread.model] ?? DEFAULT_CONTEXT_LIMIT
  }, [thread])

  // context_window on usage/thread = tokens currently in the context window.
  const contextTokens = usage?.context_window ?? thread?.context_window ?? 0
  const contextPercent = contextLimit > 0 ? Math.min(100, Math.round((contextTokens / contextLimit) * 100)) : 0

  const pickImages = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 5,
      base64: true,
      quality: 0.8,
    })
    if (result.canceled) return
    const picked: PendingImage[] = result.assets
      .filter((asset) => asset.base64)
      .map((asset, index) => ({
        id: `${Date.now()}-${index}`,
        name: asset.fileName ?? `image-${index + 1}.jpg`,
        dataUrl: `data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`,
      }))
    setAttachments((prev) => [...prev, ...picked])
  }

  const handleSend = (content: string, planMode: boolean) => {
    const pending = attachments
    setAttachments([])
    void (async () => {
      try {
        // Desktop parity: save attachments host-side, reference as @ mentions.
        let finalContent = content
        if (pending.length > 0) {
          const connection = useHostsStore.getState().activeConnection()
          if (!connection) throw new Error('No active host connection')
          const savedPaths: string[] = []
          for (const attachment of pending) {
            const { tempPath } = await rpc(connection, 'attachments:save', attachment.dataUrl, attachment.name, threadId)
            savedPaths.push(tempPath)
          }
          const mentions = savedPaths.map((p) => `@${p}`).join(' ')
          finalContent = finalContent ? `${mentions}\n\n${finalContent}` : mentions
        }
        appendUserMessage(threadId, finalContent)
        await sendMessage(threadId, finalContent, planMode ? { planMode: true } : undefined)
      } catch (error) {
        setAttachments(pending)
        Alert.alert('Send failed', errorText(error))
      }
    })()
  }

  const handleStop = () => {
    stopThread(threadId).catch((error: unknown) => Alert.alert('Stop failed', errorText(error)))
  }

  // Thread action menu (Android caps Alert.alert at 3 buttons — use a sheet).
  const threadMenuOptions = thread
    ? [
        {
          label: 'Reset session',
          onPress: () =>
            Alert.alert('Reset session?', 'Clears the agent context for this thread (messages are kept).', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Reset', style: 'destructive' as const, onPress: () => void useThreadsStore.getState().reset(threadId) },
            ]),
        },
        {
          label: 'Archive',
          onPress: () =>
            void useThreadsStore
              .getState()
              .archive(projectId, threadId)
              .then(() => useUiStore.getState().clearSelection())
              .catch((e: unknown) => Alert.alert('Archive failed', errorText(e))),
        },
        {
          label: 'Delete',
          destructive: true,
          onPress: () =>
            Alert.alert('Delete thread?', `Permanently delete "${thread.name}" and its messages?`, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive' as const,
                onPress: () =>
                  void useThreadsStore
                    .getState()
                    .remove(projectId, threadId)
                    .then(() => useUiStore.getState().clearSelection())
                    .catch((e: unknown) => Alert.alert('Delete failed', errorText(e))),
              },
            ]),
        },
      ]
    : []

  return (
    <View style={styles.screen}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onOpenSidebar} hitSlop={10}>
          <Text style={styles.menuIcon}>☰</Text>
        </Pressable>
        <Pressable style={{ flex: 1, gap: 2 }} onLongPress={() => setShowThreadMenu(true)}>
          <Text style={styles.title} numberOfLines={1}>
            {thread?.name ?? 'Thread'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <StatusDot status={status} size={7} />
            <Text style={styles.statusText}>{statusLabel(status)}</Text>
            {contextTokens > 0 ? (
              <Text style={styles.statusText}>
                · {formatTokens(contextTokens)} ctx ({contextPercent}%)
              </Text>
            ) : null}
          </View>
        </Pressable>
        {plan ? (
          <Pressable onPress={() => setShowPlan(true)} hitSlop={8}>
            <Text style={styles.headerIcon}>📋</Text>
          </Pressable>
        ) : null}
        {repoPath ? (
          <>
            <Pressable onPress={() => setShowFiles(true)} hitSlop={8}>
              <Text style={styles.headerIcon}>🗂</Text>
            </Pressable>
            <Pressable onPress={() => setShowGit(true)} hitSlop={8}>
              <Text style={styles.headerIcon}>⎇</Text>
            </Pressable>
          </>
        ) : null}
        <TodoBadge todos={todos ?? []} onPress={() => setShowTodos(true)} />
      </View>

      <SessionTabs threadId={threadId} onSwitched={refetchAll} />

      {/* Messages */}
      <Animated.View style={[{ flex: 1, backgroundColor: colors.surface }, keyboardPadStyle]}>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <MessageList messages={messages} working={status === 'running' || status === 'stopping'} />
        </View>

        {rateLimit && (rateLimit.status === 'blocked' || rateLimit.status === 'allowed_warning') ? (
          <View style={styles.rateLimitBanner}>
            <Text style={styles.rateLimitText}>
              {rateLimit.status === 'blocked' ? 'Rate limited' : 'Approaching rate limit'}
              {typeof rateLimit.utilization === 'number' ? ` · ${Math.round(rateLimit.utilization)}% used` : ''}
              {rateLimit.resetsAt ? ` · resets ${new Date(rateLimit.resetsAt * 1000).toLocaleTimeString()}` : ''}
            </Text>
          </View>
        ) : null}

        {status === 'plan_pending' ? (
          <PlanBanner
            onApprove={() => void interactions.approvePlan(threadId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))}
            onReject={() => void interactions.rejectPlan(threadId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))}
            onExecuteInNewContext={() =>
              void interactions.executePlanInNewContext(threadId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))
            }
          />
        ) : null}

        {status === 'question_pending' && questions ? (
          <QuestionBanner
            questions={questions}
            onSubmit={(answers, comments, generalComment) =>
              void interactions
                .answerQuestions(threadId, answers, comments, generalComment)
                .catch((e: unknown) => Alert.alert('Failed to submit answers', errorText(e)))
            }
          />
        ) : null}

        {status === 'permission_pending' && permissions ? (
          <PermissionBanner
            permissions={permissions}
            onApprove={(requestId) =>
              void interactions.approvePermission(threadId, requestId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))
            }
            onDeny={(requestId) =>
              void interactions.denyPermission(threadId, requestId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))
            }
          />
        ) : null}

        <InputBar
          status={status}
          onSend={handleSend}
          onStop={handleStop}
          slashCommands={slashCommands}
          attachments={attachments}
          onAddAttachment={() => void pickImages().catch((e: unknown) => Alert.alert('Could not pick image', errorText(e)))}
          onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
          accessories={
            thread ? (
              <>
                <Chip
                  label={`⚙ ${modelLabel(thread.provider, thread.model)} · ${effortLabel(thread.provider, thread.reasoning_level)}${thread.permission_mode === 'yolo' ? ' · YOLO' : ''}`}
                  onPress={() => setShowSettings(true)}
                  active
                  color={thread.permission_mode === 'yolo' ? colors.danger : undefined}
                />
                {favourites.map((favourite, index) => {
                  const current: Favourite = {
                    provider: thread.provider as Favourite['provider'],
                    model: thread.model,
                    reasoningLevel: thread.reasoning_level,
                  }
                  const isActive = favouriteEquals(favourite, current)
                  return (
                    <Chip
                      key={index}
                      label={`★ ${favouriteChipLabel(favourite)}`}
                      active={isActive}
                      onPress={() => {
                        if (isActive) return
                        void (async () => {
                          await updateProviderAndModel(projectId, threadId, favourite.provider, favourite.model)
                          await useThreadsStore.getState().updateReasoningLevel(threadId, favourite.reasoningLevel)
                        })().catch((e: unknown) => Alert.alert('Failed to apply favourite', errorText(e)))
                      }}
                    />
                  )
                })}
              </>
            ) : undefined
          }
        />
      </Animated.View>

      <TodoSheet todos={todos ?? []} visible={showTodos} onClose={() => setShowTodos(false)} />
      <ActionSheet
        visible={showThreadMenu}
        title={thread?.name}
        options={threadMenuOptions}
        onClose={() => setShowThreadMenu(false)}
      />
      <GitPanel repoPath={repoPath} visible={showGit} onClose={() => setShowGit(false)} />
      <FileBrowser rootPath={repoPath} visible={showFiles} onClose={() => setShowFiles(false)} />
      <PlanSheet plan={plan} visible={showPlan} onClose={() => setShowPlan(false)} />

      {/* Settings drawer */}
      {thread ? (
        <ThreadSettingsSheet
          thread={thread}
          visible={showSettings}
          onClose={() => setShowSettings(false)}
          onSelectModel={(provider, model) =>
            void updateProviderAndModel(projectId, threadId, provider, model).catch((e: unknown) =>
              Alert.alert('Failed to update model', errorText(e)),
            )
          }
          onSelectEffort={(level) =>
            void useThreadsStore
              .getState()
              .updateReasoningLevel(threadId, level)
              .catch((e: unknown) => Alert.alert('Failed to update reasoning level', errorText(e)))
          }
          onSelectPermissionMode={(mode: PermissionMode) =>
            void setPermissionMode(projectId, threadId, mode).catch((e: unknown) =>
              Alert.alert('Failed to update permission mode', errorText(e)),
            )
          }
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuIcon: { color: colors.text, fontSize: 20 },
  headerIcon: { color: colors.textMuted, fontSize: 17 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  statusText: { color: colors.textMuted, fontSize: 12 },
  rateLimitBanner: {
    backgroundColor: 'rgba(251, 191, 36, 0.10)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(251, 191, 36, 0.35)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rateLimitText: { color: colors.warning, fontSize: 12, fontWeight: '500' },
  controls: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
})
