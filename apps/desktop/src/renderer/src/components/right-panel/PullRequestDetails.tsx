import type { ComponentType } from 'react'
import { Ban, CircleCheck, CircleX, Clock, GitMerge, LoaderCircle, MessageSquare, TriangleAlert, UserCheck, UserX } from 'lucide-react'
import type { PullRequest } from '../../types/ipc'

const GREEN = '#4ade80'
const RED = '#f87171'
const AMBER = '#fbbf24'
const BLUE = '#60a5fa'
const MUTED = 'var(--color-text-muted)'

type Chip = { key: string; icon: ComponentType<{ size?: number; className?: string }>; label: string; title: string; color: string; spin?: boolean }

function checkIcon(status: 'passed' | 'processing' | 'failed') {
  return status === 'passed' ? { icon: CircleCheck, color: GREEN } : status === 'processing' ? { icon: LoaderCircle, color: BLUE, spin: true } : { icon: CircleX, color: RED }
}

/** Compact, at-a-glance status row for a Pull Request: one icon chip per signal, details in tooltips. */
export function PullRequestDetails({ pr }: { pr: PullRequest }) {
  const chips: Chip[] = []
  const checks = pr.checks ?? []

  if (pr.mergeStatus && pr.mergeStatus !== 'unknown') {
    chips.push(pr.mergeStatus === 'ready'
      ? { key: 'merge', icon: GitMerge, label: 'Ready', title: 'Merge status: ready to merge', color: GREEN }
      : pr.mergeStatus === 'conflicting'
        ? { key: 'merge', icon: TriangleAlert, label: 'Conflicts', title: 'Merge status: has conflicts', color: RED }
        : { key: 'merge', icon: Ban, label: 'Blocked', title: 'Merge status: blocked', color: AMBER })
  }

  if (pr.checkStatus && pr.checkStatus !== 'none') {
    const passed = checks.filter((check) => check.status === 'passed').length
    const summary = checks.length > 0 ? `${passed}/${checks.length}` : pr.checkStatus === 'passed' ? 'Passed' : pr.checkStatus === 'processing' ? 'Running' : 'Failed'
    const detail = checks.length > 0 ? `\n${checks.map((check) => `${check.name}: ${check.status}`).join('\n')}` : ''
    chips.push({ key: 'checks', ...checkIcon(pr.checkStatus), label: summary, title: `CI checks: ${pr.checkStatus}${detail}` })
  }

  if (pr.unresolvedCommentCount !== undefined) {
    const n = pr.unresolvedCommentCount
    chips.push({ key: 'comments', icon: MessageSquare, label: String(n), title: `${n} unresolved review comment${n === 1 ? '' : 's'}`, color: n > 0 ? AMBER : MUTED })
  }

  if (pr.reviewStatus && pr.reviewStatus !== 'none') {
    chips.push(pr.reviewStatus === 'approved'
      ? { key: 'review', icon: UserCheck, label: 'Approved', title: 'Review status: approved', color: GREEN }
      : pr.reviewStatus === 'changes-requested'
        ? { key: 'review', icon: UserX, label: 'Changes', title: 'Review status: changes requested', color: RED }
        : { key: 'review', icon: Clock, label: 'Review', title: 'Review status: waiting for review', color: AMBER })
  }

  // Individual pipelines only get a row when something needs attention; a green summary chip says enough.
  const attentionChecks = checks.filter((check) => check.status !== 'passed')
  if (chips.length === 0 && attentionChecks.length === 0) return null

  return <div className="mt-1 flex flex-col gap-0.5">
    <div className="flex flex-wrap items-center gap-1" role="list" aria-label="Pull request status">
      {chips.map(({ key, icon: Icon, label, title, color, spin }) =>
        <span key={key} role="listitem" className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] leading-none" title={title} aria-label={title} style={{ background: 'rgba(255,255,255,0.06)', color }}>
          <Icon size={10} className={spin ? 'animate-spin' : undefined} aria-hidden="true" />{label}
        </span>)}
    </div>
    {attentionChecks.length > 0 && <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {attentionChecks.map((check) => {
        const { icon: Icon, color, spin } = checkIcon(check.status)
        const label = `${check.name}: ${check.status === 'processing' ? 'Queued / running' : 'Failed'}`
        const inner = <><Icon size={10} className={spin ? 'animate-spin' : undefined} aria-hidden="true" />{check.name}</>
        return check.url
          ? <a key={check.name} href={check.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[9px] leading-none hover:underline" style={{ color }} title={`Open pipeline run: ${label}`} aria-label={label}>{inner}</a>
          : <span key={check.name} className="inline-flex items-center gap-0.5 text-[9px] leading-none" style={{ color }} title={label} aria-label={label}>{inner}</span>
      })}
    </div>}
  </div>
}
