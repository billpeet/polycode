import * as ImagePicker from 'expo-image-picker'
import type { SendOptions } from '@polycode/shared'
import { rpc } from '@/api/rpc'
import { useHostsStore } from '@/stores/hosts'

/** An image picked on the device but not yet saved to the host. */
export interface PendingImage {
  id: string
  name: string
  dataUrl: string
}

/** Opens the photo library and returns the chosen images as data URLs (empty when cancelled). */
export async function pickImages(): Promise<PendingImage[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: 5,
    base64: true,
    quality: 0.8,
  })
  if (result.canceled) return []
  return result.assets
    .filter((asset) => asset.base64)
    .map((asset, index) => ({
      id: `${Date.now()}-${index}`,
      name: asset.fileName ?? `image-${index + 1}.jpg`,
      dataUrl: `data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`,
    }))
}

/**
 * Saves pending images host-side and folds them into the outgoing message the
 * way the desktop does: `@path` mentions prepended to the text, plus the
 * structured `attachments` option for providers with native image input.
 */
export async function saveAttachments(
  threadId: string,
  content: string,
  pending: PendingImage[],
): Promise<{ content: string; attachments: NonNullable<SendOptions['attachments']> }> {
  if (pending.length === 0) return { content, attachments: [] }
  const connection = useHostsStore.getState().activeConnection()
  if (!connection) throw new Error('No active host connection')
  const paths: string[] = []
  for (const attachment of pending) {
    const { tempPath } = await rpc(connection, 'attachments:save', attachment.dataUrl, attachment.name, threadId)
    paths.push(tempPath)
  }
  const mentions = paths.map((p) => `@${p}`).join(' ')
  return {
    content: content ? `${mentions}\n\n${content}` : mentions,
    attachments: paths.map((path) => ({ path, detail: 'auto' as const })),
  }
}

export function newClientMessageId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
