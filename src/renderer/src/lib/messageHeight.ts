import type { MessageEntry, MessageGroup } from '../components/MessageStream'

const LINE_HEIGHT_PX = 22
const USER_BASE_HEIGHT_PX = 72
const ASSISTANT_BASE_HEIGHT_PX = 56
const TOOL_CALL_HEIGHT_PX = 48
const TOOL_GROUP_HEIGHT_PX = 52
const ERROR_HEIGHT_PX = 56
const THINKING_HEIGHT_PX = 40

const USER_CHARS_PER_LINE_FALLBACK = 56
const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72
const USER_BUBBLE_WIDTH_RATIO = 0.8
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 32
const ASSISTANT_HORIZONTAL_PADDING_PX = 32
const USER_AVG_CHAR_WIDTH_PX = 8.4
const ASSISTANT_AVG_CHAR_WIDTH_PX = 7.2

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1
  let lines = 0
  let currentLineLength = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine))
      currentLineLength = 0
      continue
    }
    currentLineLength += 1
  }
  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine))
  return lines
}

function estimateUserCharsPerLine(containerWidthPx: number | null): number {
  if (!containerWidthPx || containerWidthPx <= 0) return USER_CHARS_PER_LINE_FALLBACK
  const bubbleWidth = containerWidthPx * USER_BUBBLE_WIDTH_RATIO
  const textWidth = Math.max(bubbleWidth - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0)
  return Math.max(4, Math.floor(textWidth / USER_AVG_CHAR_WIDTH_PX))
}

function estimateAssistantCharsPerLine(containerWidthPx: number | null): number {
  if (!containerWidthPx || containerWidthPx <= 0) return ASSISTANT_CHARS_PER_LINE_FALLBACK
  const textWidth = Math.max(containerWidthPx - ASSISTANT_HORIZONTAL_PADDING_PX, 0)
  return Math.max(20, Math.floor(textWidth / ASSISTANT_AVG_CHAR_WIDTH_PX))
}

export function estimateEntryHeight(
  entry: MessageEntry | MessageGroup,
  containerWidthPx: number | null
): number {
  if (entry.kind === 'group') {
    return TOOL_GROUP_HEIGHT_PX
  }

  const { message, metadata } = entry

  if (metadata?.type === 'thinking') return THINKING_HEIGHT_PX
  if (metadata?.type === 'tool_call' || metadata?.type === 'tool_use') return TOOL_CALL_HEIGHT_PX
  if (metadata?.type === 'tool_result') return TOOL_CALL_HEIGHT_PX
  if (message.role === 'system' || metadata?.type === 'error') return ERROR_HEIGHT_PX

  if (message.role === 'user') {
    const charsPerLine = estimateUserCharsPerLine(containerWidthPx)
    const lines = estimateWrappedLineCount(message.content, charsPerLine)
    return USER_BASE_HEIGHT_PX + lines * LINE_HEIGHT_PX
  }

  // assistant
  const charsPerLine = estimateAssistantCharsPerLine(containerWidthPx)
  const lines = estimateWrappedLineCount(message.content, charsPerLine)
  return ASSISTANT_BASE_HEIGHT_PX + lines * LINE_HEIGHT_PX
}
