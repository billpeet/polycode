import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { PermissionRequest, Question, QuestionAnswerValue } from '@polycode/shared'
import { Button, Chip } from './ui'
import { colors } from '@/theme/colors'

// ── Permission requests ──────────────────────────────────────────────────────

export function PermissionBanner(props: {
  permissions: PermissionRequest[]
  onApprove: (requestId?: string) => void
  onDeny: (requestId?: string) => void
}) {
  if (props.permissions.length === 0) return null
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerTitle}>Permission required</Text>
      <ScrollView style={{ maxHeight: 260 }}>
        {props.permissions.map((permission) => (
          <View key={permission.requestId} style={styles.permissionCard}>
            <Text style={styles.permissionTool}>{permission.toolName}</Text>
            {permission.description ? (
              <Text style={styles.permissionDescription} numberOfLines={4}>
                {permission.description}
              </Text>
            ) : null}
            <View style={styles.buttonRow}>
              <Button small title="Deny" variant="danger" onPress={() => props.onDeny(permission.requestId)} style={{ flex: 1 }} />
              <Button small title="Approve" onPress={() => props.onApprove(permission.requestId)} style={{ flex: 1 }} />
            </View>
          </View>
        ))}
      </ScrollView>
      {props.permissions.length > 1 ? (
        <View style={styles.buttonRow}>
          <Button small title="Deny All" variant="danger" onPress={() => props.onDeny()} style={{ flex: 1 }} />
          <Button small title="Approve All" onPress={() => props.onApprove()} style={{ flex: 1 }} />
        </View>
      ) : null}
    </View>
  )
}

// ── Plan approval ────────────────────────────────────────────────────────────

export function PlanBanner(props: {
  onApprove: () => void
  onReject: () => void
  onExecuteInNewContext: () => void
}) {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerTitle}>Plan ready for review</Text>
      <Text style={styles.bannerSubtitle}>Review the plan above, then approve to start execution.</Text>
      <View style={styles.buttonRow}>
        <Button small title="Reject" variant="danger" onPress={props.onReject} style={{ flex: 1 }} />
        <Button small title="New Context" variant="secondary" onPress={props.onExecuteInNewContext} style={{ flex: 1 }} />
        <Button small title="Approve" onPress={props.onApprove} style={{ flex: 1 }} />
      </View>
    </View>
  )
}

// ── Questions (AskUserQuestion) ──────────────────────────────────────────────

export function QuestionBanner(props: {
  questions: Question[]
  onSubmit: (
    answers: Record<string, QuestionAnswerValue>,
    questionComments: Record<string, string>,
    generalComment: string,
  ) => void
}) {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerValue>>({})
  const [comments, setComments] = useState<Record<string, string>>({})
  const [generalComment, setGeneralComment] = useState('')

  // Reset local state when a new question batch arrives.
  useEffect(() => {
    setAnswers({})
    setComments({})
    setGeneralComment('')
  }, [props.questions])

  if (props.questions.length === 0) return null

  const toggleOption = (question: Question, label: string) => {
    const key = question.id ?? question.question
    setAnswers((prev) => {
      const current = prev[key]
      if (!question.multiSelect) {
        return { ...prev, [key]: current === label ? '' : label }
      }
      const list = Array.isArray(current) ? current : current ? [current] : []
      const next = list.includes(label) ? list.filter((l) => l !== label) : [...list, label]
      return { ...prev, [key]: next }
    })
  }

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerTitle}>The agent has a question</Text>
      <ScrollView style={{ maxHeight: 340 }}>
        {props.questions.map((question, index) => {
          const key = question.id ?? question.question
          const current = answers[key]
          return (
            <View key={index} style={{ marginBottom: 12, gap: 8 }}>
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
                <Text style={styles.questionHeader}>{question.header}</Text>
                <Text style={styles.questionText}>{question.question}</Text>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {question.options.map((option, optionIndex) => {
                  const selected = Array.isArray(current) ? current.includes(option.label) : current === option.label
                  return (
                    <Chip
                      key={optionIndex}
                      label={option.label}
                      active={selected}
                      color={colors.info}
                      onPress={() => toggleOption(question, option.label)}
                    />
                  )
                })}
              </View>
              <TextInput
                style={styles.commentInput}
                placeholder="Comment (optional)"
                placeholderTextColor={colors.textMuted}
                value={comments[key] ?? ''}
                onChangeText={(text) => setComments((prev) => ({ ...prev, [key]: text }))}
              />
            </View>
          )
        })}
      </ScrollView>
      <TextInput
        style={styles.commentInput}
        placeholder="General comments… (optional)"
        placeholderTextColor={colors.textMuted}
        value={generalComment}
        onChangeText={setGeneralComment}
      />
      <Button small title="Submit Answers" onPress={() => props.onSubmit(answers, comments, generalComment)} />
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: 12,
    gap: 10,
  },
  bannerTitle: { color: colors.info, fontSize: 13, fontWeight: '700' },
  bannerSubtitle: { color: colors.textMuted, fontSize: 12 },
  permissionCard: {
    backgroundColor: colors.surface2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 8,
    marginBottom: 8,
  },
  permissionTool: { color: colors.text, fontSize: 14, fontWeight: '600', fontFamily: 'monospace' },
  permissionDescription: { color: colors.textMuted, fontSize: 12.5 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  questionHeader: {
    color: colors.info,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: 'rgba(96, 165, 250, 0.15)',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  questionText: { color: colors.text, fontSize: 13.5, flex: 1 },
  commentInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    color: colors.text,
    fontSize: 13,
  },
})
