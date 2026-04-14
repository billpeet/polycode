import { Component, type ErrorInfo, type ReactNode } from 'react'

interface PanelErrorBoundaryProps {
  context: string
  onDismiss?: () => void
  children: ReactNode
}

interface PanelErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export default class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[renderer] ${this.props.context} crashed`, error, errorInfo)
  }

  componentDidUpdate(prevProps: PanelErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.context !== this.props.context) {
      this.setState({ hasError: false, error: null })
    }
  }

  private handleDismiss = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onDismiss?.()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <div className="space-y-1">
          <div className="text-sm" style={{ color: 'var(--color-text)' }}>
            {this.props.context} failed to render.
          </div>
          <div className="text-xs">
            The error was logged to the console. You can close this panel and keep using the app.
          </div>
          {this.state.error?.message && (
            <div className="text-[11px]" style={{ opacity: 0.8 }}>
              {this.state.error.message}
            </div>
          )}
        </div>
        <button
          onClick={this.handleDismiss}
          className="rounded px-3 py-1.5 text-xs transition-colors hover:opacity-90"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text)' }}
        >
          Close panel
        </button>
      </div>
    )
  }
}
