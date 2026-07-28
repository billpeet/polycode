import { Component, type ErrorInfo, type ReactNode } from 'react'

export type UiErrorBoundaryVariant = 'entry' | 'region' | 'root'

interface UiErrorBoundaryProps {
  context: string
  variant?: UiErrorBoundaryVariant
  resetKeys?: readonly unknown[]
  onDismiss?: () => void
  onEscape?: () => void
  children: ReactNode
}

interface UiErrorBoundaryState {
  error: Error | null
}

export default class UiErrorBoundary extends Component<UiErrorBoundaryProps, UiErrorBoundaryState> {
  state: UiErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): UiErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[renderer] ${this.props.context} failed to render`, error, {
      componentStack: errorInfo.componentStack,
    })
  }

  componentDidUpdate(prevProps: UiErrorBoundaryProps): void {
    const previousKeys = prevProps.resetKeys ?? []
    const currentKeys = this.props.resetKeys ?? []
    const resetKeysChanged =
      previousKeys.length !== currentKeys.length ||
      previousKeys.some((key, index) => !Object.is(key, currentKeys[index]))

    if (this.state.error && resetKeysChanged) {
      this.setState({ error: null })
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  private handleDismiss = (): void => {
    this.setState({ error: null })
    this.props.onDismiss?.()
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    if (this.props.variant === 'entry') {
      return (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-xs"
          style={{
            background: 'rgba(248, 113, 113, 0.06)',
            borderColor: 'rgba(248, 113, 113, 0.35)',
            color: 'var(--color-text-muted)',
          }}
        >
          <span>This entry could not be displayed.</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="shrink-0 rounded px-2 py-1 hover:opacity-90"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-text)' }}
          >
            Retry
          </button>
        </div>
      )
    }

    return (
      <div
        role="alert"
        className="flex h-full min-h-24 flex-col items-center justify-center gap-3 px-4 text-center"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <div className="space-y-1">
          <div className="text-sm" style={{ color: 'var(--color-text)' }}>
            {this.props.context} could not be displayed.
          </div>
          <div className="text-xs">The rest of PolyCode is still available.</div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded px-3 py-1.5 text-xs transition-colors hover:opacity-90"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-text)' }}
          >
            Retry
          </button>
          {this.props.onDismiss && (
            <button
              type="button"
              onClick={this.handleDismiss}
              className="rounded px-3 py-1.5 text-xs transition-colors hover:opacity-90"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Close
            </button>
          )}
          {this.props.variant === 'root' && this.props.onEscape && (
            <button
              type="button"
              onClick={this.props.onEscape}
              className="rounded px-3 py-1.5 text-xs transition-colors hover:opacity-90"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Return to navigation
            </button>
          )}
        </div>
      </div>
    )
  }
}
