/**
 * Inline attachment rendering for @-mention paths in messages. Images are
 * fetched from the host as data URLs (attachments:readDataUrl) since the
 * Electron-only attachment:// protocol is unavailable remotely.
 */
import { memo, useEffect, useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'
import { colors } from '@/theme/colors'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

export interface AttachmentRef {
  threadId: string
  filename: string
}

/** Matches "@…polycode-attachments/<threadId>/<filename>" mentions. */
const ATTACHMENT_MENTION_REGEX = /@\S*polycode-attachments[\\/]([^\\/\s]+)[\\/](\S+)/g

/** Split message content into attachment refs + remaining text. */
export function extractAttachments(content: string): { attachments: AttachmentRef[]; text: string } {
  const attachments: AttachmentRef[] = []
  ATTACHMENT_MENTION_REGEX.lastIndex = 0
  const text = content
    .replace(ATTACHMENT_MENTION_REGEX, (_match, threadId: string, filename: string) => {
      attachments.push({ threadId, filename })
      return ''
    })
    .replace(/^[ \t]*\n+/, '')
    .trim()
  return { attachments, text }
}

function isImage(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}

// Session-lifetime cache: attachment files are immutable once saved.
const dataUrlCache = new Map<string, string | null>()

export const AttachmentView = memo(function AttachmentView({ threadId, filename }: AttachmentRef) {
  const [dataUrl, setDataUrl] = useState<string | null | undefined>(() =>
    dataUrlCache.get(`${threadId}/${filename}`),
  )
  const [aspectRatio, setAspectRatio] = useState(4 / 3)
  const image = isImage(filename)

  useEffect(() => {
    if (!image || dataUrl !== undefined) return
    const key = `${threadId}/${filename}`
    const connection = useHostsStore.getState().activeConnection()
    if (!connection) return
    let cancelled = false
    rpc(connection, 'attachments:readDataUrl', threadId, filename)
      .then((url) => {
        dataUrlCache.set(key, url)
        if (!cancelled) setDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [image, threadId, filename, dataUrl])

  useEffect(() => {
    if (dataUrl) {
      Image.getSize(
        dataUrl,
        (width, height) => {
          if (width > 0 && height > 0) setAspectRatio(width / height)
        },
        () => undefined,
      )
    }
  }, [dataUrl])

  if (image && dataUrl) {
    return <Image source={{ uri: dataUrl }} style={[styles.image, { aspectRatio }]} resizeMode="contain" />
  }

  return (
    <View style={styles.fileChip}>
      <Text style={styles.fileChipText} numberOfLines={1}>
        {image ? '🖼' : '📎'} {filename}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create({
  image: {
    width: '100%',
    maxWidth: 280,
    maxHeight: 320,
    borderRadius: 10,
    backgroundColor: colors.codeBg,
  },
  fileChip: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.25)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 260,
  },
  fileChipText: { color: colors.text, fontSize: 12.5 },
})
