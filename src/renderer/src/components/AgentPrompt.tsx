import MarkdownContent from './MarkdownContent'

interface Props {
  prompt: string
  /** Render expanded by default (used in the isolated view where there's room). */
  defaultOpen?: boolean
}

/** Collapsible "PROMPT" block showing the full prompt sent to a sub-agent. */
export default function AgentPrompt({ prompt, defaultOpen = false }: Props) {
  return (
    <details
      open={defaultOpen}
      style={{
        margin: '2px 0 6px',
        borderLeft: '2px solid var(--color-border)',
        borderRadius: '0 4px 4px 0',
        background: 'var(--color-surface)',
        padding: '4px 8px',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          color: 'var(--color-text-muted)',
          userSelect: 'none',
        }}
      >
        PROMPT
      </summary>
      <div style={{ marginTop: 4, fontSize: '0.8rem', color: 'var(--color-text)' }}>
        <MarkdownContent content={prompt} />
      </div>
    </details>
  )
}
