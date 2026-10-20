import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { FULL_MESSAGE_LIMIT, type Message } from '@polycode/shared'
import { useMessagesStore } from '@/stores/messages'
import { colors } from '@/theme/colors'

/**
 * Says how much of a very large message a transcript page left out, and fetches the
 * rest on request unless it is too large to render on a phone.
 */
export function OmittedNotice({ message }: { message: Message | null | undefined }) {
  const expandMessage = useMessagesStore((s) => s.expandMessage)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const omitted = message?.omitted_chars
  if (!message || !omitted) return null

  const fullSize = message.content.length + (message.metadata?.length ?? 0) + omitted
  const canExpand = fullSize <= FULL_MESSAGE_LIMIT.mobile
  const expand = () => {
    setState('loading')
    expandMessage(message).then(() => setState('idle'), () => setState('failed'))
  }

  return (
    <View style={styles.row}>
      <Text style={styles.text}>
        {omitted.toLocaleString()} characters left out{canExpand ? '.' : ' — too large to show on a phone.'}
      </Text>
      {canExpand ? (
        <Pressable onPress={expand} disabled={state === 'loading'} style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}>
          <Text style={styles.text}>{state === 'loading' ? 'Loading…' : state === 'failed' ? 'Retry' : 'Show all'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  text: { color: colors.textMuted, fontSize: 12 },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
})
