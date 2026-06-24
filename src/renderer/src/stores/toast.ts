import { create } from 'zustand'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
  title?: string
  details?: string
  duration?: number // ms, default 4000; 0 = persist until dismissed
  actionLabel?: string
  onAction?: () => void | Promise<void>
}

interface ToastStore {
  toasts: Toast[]
  add: (toast: Omit<Toast, 'id'>) => void
  remove: (id: string) => void
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  add: (toast) => {
    const id = crypto.randomUUID()
    const duration = toast.duration ?? 4000
    const details = toast.details ?? (toast.type === 'error'
      ? JSON.stringify({
          title: toast.title ?? null,
          message: toast.message,
          timestamp: new Date().toISOString(),
        }, null, 2)
      : undefined)
    set((s) => ({ toasts: [...s.toasts, { ...toast, id, duration, details }] }))
    if (duration > 0) {
      setTimeout(() => get().remove(id), duration)
    }
  },

  remove: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
