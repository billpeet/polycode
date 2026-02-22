import { create } from 'zustand'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
  duration?: number // ms, default 4000; 0 = persist until dismissed
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
    set((s) => ({ toasts: [...s.toasts, { ...toast, id, duration }] }))
    if (duration > 0) {
      setTimeout(() => get().remove(id), duration)
    }
  },

  remove: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
