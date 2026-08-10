import { useState } from 'react'
import { Check, ShieldAlert, X } from 'lucide-react'
import type { PendingApprovalEntry } from '@/types/ui'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { formatJson } from '@/lib/utils'

export interface ApprovalVerdict {
  callId: string
  approved: boolean
  note: string
}

interface ApprovalRequestProps {
  approvals: PendingApprovalEntry[]
  /** Tool id → display name, from GET /api/tools. Falls back to the id. */
  toolNames?: Record<string, string>
  /** node_id → label, from the saved workflow. */
  labels?: Record<string, string>
  onDecide: (verdicts: ApprovalVerdict[]) => void
  busy?: boolean
}

/**
 * The gate, as the reviewer meets it.
 *
 * Two rules shape this component. **Show the arguments, unfolded** — an
 * approval where the recipient is behind a disclosure triangle is a rubber
 * stamp, and the whole feature exists to not be one. And **make the two
 * choices equally reachable**: Reject is not a cancel button hidden in a corner,
 * it is the other half of the decision, which is why both are real buttons and
 * neither is the one you hit by pressing Enter.
 */
export function ApprovalRequest({
  approvals,
  toolNames,
  labels,
  onDecide,
  busy = false,
}: ApprovalRequestProps) {
  const [note, setNote] = useState('')

  if (approvals.length === 0) return null

  const plural = approvals.length > 1

  function decide(approved: boolean) {
    onDecide(
      approvals.map((approval) => ({ callId: approval.callId, approved, note: note.trim() })),
    )
  }

  return (
    <section
      aria-label={plural ? 'Actions awaiting approval' : 'Action awaiting approval'}
      className="mt-3 overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/5"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
        <h3 className="text-sm font-medium">
          {plural ? `${approvals.length} actions need your approval` : 'This action needs approval'}
        </h3>
      </header>

      <p className="px-3 pb-2 text-xs text-muted-foreground">
        The workflow is paused. {plural ? 'These calls have' : 'This call has'} not run, and{' '}
        {plural ? 'they' : 'it'} will not run unless you approve {plural ? 'them' : 'it'}.
      </p>

      <ul className="space-y-2 px-3">
        {approvals.map((approval) => (
          <li key={approval.callId} className="rounded-md border bg-card">
            <div className="flex flex-wrap items-baseline gap-x-2 px-2.5 py-1.5">
              <span className="text-sm font-medium">
                {toolNames?.[approval.tool] ?? approval.tool}
              </span>
              {approval.nodeId && (
                <span className="text-xs text-muted-foreground">
                  {labels?.[approval.nodeId] ?? approval.nodeId}
                </span>
              )}
            </div>
            {/* Never collapsed: the arguments are the thing being approved. */}
            <pre className="mx-2.5 mb-2 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
              {formatJson(approval.input)}
            </pre>
          </li>
        ))}
      </ul>

      <div className="px-3 py-2">
        <label htmlFor="approval-note" className="text-xs text-muted-foreground">
          Note (optional) — the agent sees this
        </label>
        <Textarea
          id="approval-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={busy}
          rows={2}
          className="mt-1 text-sm"
          placeholder="Why you approved or rejected this…"
        />
      </div>

      <div className="flex flex-wrap gap-2 px-3 pb-3">
        <Button size="sm" onClick={() => decide(true)} disabled={busy}>
          <Check aria-hidden />
          Approve{plural ? ' all' : ''}
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide(false)} disabled={busy}>
          <X aria-hidden />
          Reject{plural ? ' all' : ''}
        </Button>
        {busy && (
          <span
            role="status"
            aria-live="polite"
            className="self-center text-xs text-muted-foreground"
          >
            Continuing the run…
          </span>
        )}
      </div>
    </section>
  )
}
