/** Small shared UI primitives for the dark theme. */
import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'
import { colors } from '@/theme/colors'

export function Card(props: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, props.style]}>{props.children}</View>
}

export function Button(props: {
  title: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
  loading?: boolean
  small?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const variant = props.variant ?? 'primary'
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled || props.loading}
      style={({ pressed }) => [
        styles.button,
        props.small && styles.buttonSmall,
        variant === 'primary' && { backgroundColor: colors.claude },
        variant === 'secondary' && { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
        variant === 'danger' && { backgroundColor: '#7f1d1d' },
        variant === 'ghost' && { backgroundColor: 'transparent' },
        (props.disabled || props.loading) && { opacity: 0.5 },
        pressed && { opacity: 0.75 },
        props.style,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator size="small" color={colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            props.small && styles.buttonTextSmall,
            variant === 'primary' && { color: '#1a1a1a', fontWeight: '600' },
            variant === 'ghost' && { color: colors.claude },
          ]}
        >
          {props.title}
        </Text>
      )}
    </Pressable>
  )
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        {...rest}
        style={[styles.input, style]}
      />
    </View>
  )
}

export function EmptyState(props: { title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{props.title}</Text>
      {props.subtitle ? <Text style={styles.emptySubtitle}>{props.subtitle}</Text> : null}
    </View>
  )
}

export function Chip(props: { label: string; onPress?: () => void; active?: boolean; color?: string }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={!props.onPress}
      style={({ pressed }) => [
        styles.chip,
        props.active && { borderColor: props.color ?? colors.claude, backgroundColor: colors.surface2 },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.chipText, props.active && { color: props.color ?? colors.claude }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: {
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  buttonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  buttonTextSmall: {
    fontSize: 13,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
    backgroundColor: colors.surface,
    maxWidth: 180,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '500',
  },
})
