import type { ReactNode } from 'react'
import UiErrorBoundary from './UiErrorBoundary'

interface PanelErrorBoundaryProps {
  context: string
  onDismiss?: () => void
  children: ReactNode
}

export default function PanelErrorBoundary({ context, onDismiss, children }: PanelErrorBoundaryProps) {
  return (
    <UiErrorBoundary context={context} resetKeys={[context]} onDismiss={onDismiss}>
      {children}
    </UiErrorBoundary>
  )
}
