import type { PullRequest } from '../../types/ipc'

export function PullRequestDetails({ pr }: { pr: PullRequest }) {
  const badges: Array<{ label: string; title: string; color: string }> = []
  if (pr.mergeStatus && pr.mergeStatus !== 'unknown') {
    badges.push({
      label: pr.mergeStatus === 'ready' ? 'Merge ready' : pr.mergeStatus === 'conflicting' ? 'Conflicts' : 'Merge blocked',
      title: `Merge status: ${pr.mergeStatus}`,
      color: pr.mergeStatus === 'ready' ? '#4ade80' : pr.mergeStatus === 'conflicting' ? '#f87171' : '#fbbf24',
    })
  }
  if (pr.checkStatus && pr.checkStatus !== 'none') {
    badges.push({
      label: pr.checkStatus === 'passed' ? 'Checks passed' : pr.checkStatus === 'processing' ? 'Checks running' : 'Checks failed',
      title: `CI checks: ${pr.checkStatus}`,
      color: pr.checkStatus === 'passed' ? '#4ade80' : pr.checkStatus === 'processing' ? '#60a5fa' : '#f87171',
    })
  }
  if (pr.unresolvedCommentCount !== undefined) {
    badges.push({
      label: `${pr.unresolvedCommentCount} open comment${pr.unresolvedCommentCount === 1 ? '' : 's'}`,
      title: `${pr.unresolvedCommentCount} unresolved review comment${pr.unresolvedCommentCount === 1 ? '' : 's'}`,
      color: pr.unresolvedCommentCount > 0 ? '#fbbf24' : 'var(--color-text-muted)',
    })
  }
  if (pr.reviewStatus && pr.reviewStatus !== 'none') {
    badges.push({
      label: pr.reviewStatus === 'approved' ? 'Approved' : pr.reviewStatus === 'changes-requested' ? 'Changes requested' : 'Review pending',
      title: `Review status: ${pr.reviewStatus}`,
      color: pr.reviewStatus === 'approved' ? '#4ade80' : pr.reviewStatus === 'changes-requested' ? '#f87171' : '#fbbf24',
    })
  }
  if (badges.length === 0 && !pr.checks?.length) return null
  return <div className="mt-1 flex flex-wrap gap-1">
    {badges.map((badge) => <span key={badge.title} className="rounded px-1.5 py-0.5 text-[9px]" title={badge.title} style={{ background: 'rgba(255,255,255,0.06)', color: badge.color }}>{badge.label}</span>)}
    {pr.checks?.map((check, index) => {
      const label = `${check.name}: ${check.status === 'processing' ? 'Queued / running' : check.status === 'passed' ? 'Passed' : 'Failed'}`
      const style = { color: check.status === 'passed' ? '#4ade80' : check.status === 'processing' ? '#60a5fa' : '#f87171' }
      return check.url
        ? <a key={index} href={check.url} target="_blank" rel="noreferrer" className="rounded px-1.5 py-0.5 text-[9px] hover:underline" style={style} title={`Open pipeline run: ${check.name}`}>{label} ↗</a>
        : <span key={index} className="rounded px-1.5 py-0.5 text-[9px]" style={style}>{label}</span>
    })}
  </div>
}

