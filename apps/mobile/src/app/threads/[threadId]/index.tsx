import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  DEFAULT_CONTEXT_LIMIT,
  MODEL_CONTEXT_LIMITS,
  getModelsForProvider,
  type Message,
  type OutputEvent,
  type PermissionMode,
  type Provider,
  type ThreadStatus,
} from '@polycode/shared'
import { channels, onChannel } from '@/api/events'
import { sseManager } from '@/api/sse'
import { PermissionBanner, PlanBanner, QuestionBanner } from '@/components/Banners'
import { InputBar } from '@/components/InputBar'
import { MessageList } from '@/components/MessageList'
import { StatusDot } from '@/components/StatusDot'
import { ModelPickerSheet, PermissionModeSheet } from '@/components/ThreadControls'
import { TodoPanel } from '@/components/TodoPanel'
import { Chip } from '@/components/ui'
import { useInteractionsStore } from '@/stores/interactions'
import { useMessagesStore } from '@/stores/messages'
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

export default function ThreadScreen() {
  const router = useRouter()
  const { threadId, projectId } = useLocalSearchParams<{ threadId: string; projectId?: string }>()

  const thread = useThreadsStore((s) => (threadId ? s.findThread(threadId) : undefined))
  const fetchThreads = useThreadsStore((s) => s.fetch)
  const sendMessage = useThreadsStore((s) => s.send)
  const stopThread = useThreadsStore((s) => s.stop)
  const setUnread = useThreadsStore((s) => s.setUnread)
  const setPermissionMode = useThreadsStore((s) => s.setPermissionMode)
  const updateProviderAndModel = useThreadsStore((s) => s.updateProviderAndModel)

  const messages = useMessagesStore((s) => (threadId ? (s.messagesByThread[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES))
  const usage = useMessagesStore((s) => (threadId ? s.usageByThread[threadId] : undefined))
  const fetchMessages = useMessagesStore((s) => s.fetch)
  const appendEvent = useMessagesStore((s) => s.appendEvent)
  const appendUserMessage = useMessagesStore((s) => s.appendUserMessage)

  const todos = useTodosStore((s) => (threadId ? (s.todosByThread[threadId] ?? null) : null))
  const applyTodoEvent = useTodosStore((s) => s.applyEvent)
  const syncTodos = useTodosStore((s) => s.syncFromMessages)

  const permissions = useInteractionsStore((s) => (threadId ? (s.permissionsByThread[threadId] ?? null) : null))
  const questions = useInteractionsStore((s) => (threadId ? (s.questionsByThread[threadId] ?? null) : null))
  const interactions = useInteractionsStore()

  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showPermissionPicker, setShowPermissionPicker] = useState(false)
  const insets = useSafeAreaInsets()

  const status: ThreadStatus = thread?.status ?? 'idle'

  const refetchAll = useCallback(() => {
    if (!threadId) return
    fetchMessages(threadId)
      .then((loaded) => syncTodos(threadId, loaded))
      .catch(() => {
        // Host unreachable — the SSE reconnect loop will trigger another refetch.
      })
  }, [threadId, fetchMessages, syncTodos])

  // Ensure the thread object exists (deep links land here without the list loaded).
  useEffect(() => {
    if (!thread && projectId) void fetchThreads(projectId)
  }, [thread, projectId, fetchThreads])

  // Initial load + refetch on SSE reconnect (missed frames are not replayed).
  useEffect(() => {
    refetchAll()
    return sseManager.onConnect(refetchAll)
  }, [refetchAll])

  // Live event wiring for this thread.
  useEffect(() => {
    if (!threadId) return

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
    if (!threadId) return
    if (status === 'permission_pending') void interactions.fetchPermissions(threadId)
    if (status === 'question_pending') void interactions.fetchQuestions(threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, status])

  // Clear unread on focus.
  useFocusEffect(
    useCallback(() => {
      if (threadId && projectId && thread?.unread) {
        void setUnread(projectId, threadId, false)
      }
    }, [threadId, projectId, thread?.unread, setUnread]),
  )

  const contextLimit = useMemo(() => {
    if (!thread) return DEFAULT_CONTEXT_LIMIT
    return MODEL_CONTEXT_LIMITS[thread.model] ?? (thread.context_window || DEFAULT_CONTEXT_LIMIT)
  }, [thread])

  if (!threadId) return <View style={styles.screen} />

  const inputTokens = usage?.input_tokens ?? thread?.input_tokens ?? 0
  const contextPercent = contextLimit > 0 ? Math.min(100, Math.round((inputTokens / contextLimit) * 100)) : 0

  const handleSend = (content: string, planMode: boolean) => {
    appendUserMessage(threadId, content)
    sendMessage(threadId, content, planMode ? { planMode: true } : undefined).catch((error: unknown) => {
      Alert.alert('Send failed', errorText(error))
    })
  }

  const handleStop = () => {
    stopThread(threadId).catch((error: unknown) => Alert.alert('Stop failed', errorText(error)))
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.backIcon}>‹</Text>
        </Pressable>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title} numberOfLines={1}>
            {thread?.name ?? 'Thread'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <StatusDot status={status} size={7} />
            <Text style={styles.statusText}>{statusLabel(status)}</Text>
            {inputTokens > 0 ? (
              <Text style={styles.statusText}>
                · {formatTokens(inputTokens)} tok ({contextPercent}%)
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* Controls */}
      {thread ? (
        <View style={styles.controls}>
          <Chip label={modelLabel(thread.provider, thread.model)} onPress={() => setShowModelPicker(true)} active />
          <Chip
            label={thread.permission_mode === 'yolo' ? 'YOLO' : thread.permission_mode === 'workspace' ? 'Workspace' : 'Ask'}
            onPress={() => setShowPermissionPicker(true)}
            active
            color={thread.permission_mode === 'yolo' ? colors.danger : colors.textMuted}
          />
        </View>
      ) : null}

      {/* Messages */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={{ flex: 1 }}>
          <MessageList messages={messages} />
        </View>

        <TodoPanel todos={todos ?? []} />

        {status === 'plan_pending' ? (
          <PlanBanner
            onApprove={() => void interactions.approvePlan(threadId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))}
            onReject={() => void interactions.rejectPlan(threadId).catch((e: unknown) => Alert.alert('Failed', errorText(e)))}
            onExecuteInNewContext={() =>
              void interactions
                .executePlanInNewContext(threadId)
                .catch((e: unknown) => Alert.alert('Failed', errorText(e)))
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

        <InputBar status={status} onSend={handleSend} onStop={handleStop} />
        <View style={{ height: insets.bottom, backgroundColor: colors.surface }} />
      </KeyboardAvoidingView>

      {/* Sheets */}
      {thread && projectId ? (
        <>
          <ModelPickerSheet
            thread={thread}
            visible={showModelPicker}
            onClose={() => setShowModelPicker(false)}
            onSelect={(provider, model) =>
              void updateProviderAndModel(projectId, threadId, provider, model).catch((e: unknown) =>
                Alert.alert('Failed to update model', errorText(e)),
              )
            }
          />
          <PermissionModeSheet
            current={thread.permission_mode}
            visible={showPermissionPicker}
            onClose={() => setShowPermissionPicker(false)}
            onSelect={(mode: PermissionMode) =>
              void setPermissionMode(projectId, threadId, mode).catch((e: unknown) =>
                Alert.alert('Failed to update permission mode', errorText(e)),
              )
            }
          />
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backIcon: { color: colors.text, fontSize: 30, lineHeight: 32, marginTop: -4 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  statusText: { color: colors.textMuted, fontSize: 12 },
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
