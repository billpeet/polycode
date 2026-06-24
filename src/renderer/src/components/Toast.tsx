import { useState } from 'react'
import { useToastStore, Toast } from '../stores/toast'
import { useBackdropClose } from '../hooks/useBackdropClose'

function ErrorDetailsModal({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const backdropClose = useBackdropClose(onClose)
  const [copied, setCopied] = useState(false)
  const detailText = toast.details?.trim() || toast.message
  const title = toast.title ?? 'Error Details'

  async function copyDetails() {
    await navigator.clipboard.writeText(detailText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 1000, background: 'rgba(0,0,0,0.6)' }}
      onClick={backdropClose.onClick}
      onPointerDown={backdropClose.onPointerDown}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg"
        style={{
          width: 680,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 64px)',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-start justify-between gap-4 px-5 py-4"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              {title}
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}>
              {toast.message}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            aria-label="Close error details"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <pre
            style={{
              margin: 0,
              padding: '12px',
              borderRadius: 6,
              background: 'var(--color-code-bg)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {detailText}
          </pre>
        </div>

        <div
          className="flex justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <button
            type="button"
            onClick={copyDetails}
            className="rounded px-3 py-1.5 text-xs font-medium"
            style={{
              background: 'var(--color-surface-2)',
              border: `1px solid ${copied ? 'rgba(74,222,128,0.45)' : 'var(--color-border)'}`,
              color: copied ? '#4ade80' : 'var(--color-text)',
            }}
          >
            {copied ? 'Copied' : 'Copy Details'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs font-medium"
            style={{ background: 'var(--color-claude)', color: '#fff' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function ToastItem({ toast }: { toast: Toast }) {
  const remove = useToastStore((s) => s.remove)
  const [showDetails, setShowDetails] = useState(false)
  const canShowDetails = toast.type === 'error'

  const bg =
    toast.type === 'error'
      ? '#dc2626'
      : toast.type === 'success'
        ? '#16a34a'
        : toast.type === 'warning'
          ? '#d97706'
          : 'var(--color-surface-2)'

  const color = toast.type === 'info' ? 'var(--color-text)' : '#fff'

  const icon = toast.type === 'error' ? '✕' : toast.type === 'success' ? '✓' : toast.type === 'warning' ? '⚠' : 'ℹ'

  return (
    <>
      <div
        role={canShowDetails ? 'button' : undefined}
        tabIndex={canShowDetails ? 0 : undefined}
        onClick={() => {
          if (canShowDetails) setShowDetails(true)
        }}
        onKeyDown={(e) => {
          if (!canShowDetails) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setShowDetails(true)
          }
        }}
        title={canShowDetails ? 'Click to view error details' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          maxWidth: '360px',
          padding: '0.5rem 0.75rem',
          borderRadius: 8,
          background: bg,
          color,
          fontSize: '0.8rem',
          fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          animation: 'toast-in 0.18s ease',
          cursor: canShowDetails ? 'pointer' : 'default',
        }}
      >
        <span style={{ flexShrink: 0, opacity: 0.85 }}>{icon}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {toast.message}
        </span>
        {canShowDetails ? (
          <span style={{ flexShrink: 0, opacity: 0.8, fontSize: '0.68rem', fontWeight: 600 }}>
            Details
          </span>
        ) : null}
        {toast.actionLabel ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              void toast.onAction?.()
            }}
            style={{
              flexShrink: 0,
              background: 'transparent',
              border: `1px solid ${color}`,
              borderRadius: 4,
              cursor: 'pointer',
              color: 'inherit',
              fontSize: '0.72rem',
              lineHeight: 1,
              padding: '0.2rem 0.5rem',
              fontWeight: 600,
            }}
          >
            {toast.actionLabel}
          </button>
        ) : null}
        <button
          onClick={(e) => {
            e.stopPropagation()
            remove(toast.id)
          }}
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            opacity: 0.7,
            fontSize: '0.75rem',
            lineHeight: 1,
            padding: '0 2px',
          }}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {showDetails ? <ErrorDetailsModal toast={toast} onClose={() => setShowDetails(false)} /> : null}
    </>
  )
}

export default function ToastStack() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1rem',
        right: '1rem',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: '0.5rem',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div key={t.id} style={{ pointerEvents: 'auto' }}>
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  )
}
