import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { ValidationIssue, ValidationResult } from '@/types/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ValidationBannerProps {
  validation: ValidationResult
  onDismiss: () => void
  /** Focusing the offending node is the whole point of showing the issue. */
  onFocusNode: (nodeId: string) => void
}

function IssueRow({
  issue,
  tone,
  onFocusNode,
}: {
  issue: ValidationIssue
  tone: 'error' | 'warning'
  onFocusNode: (nodeId: string) => void
}) {
  const content = (
    <>
      <code
        className={cn(
          'shrink-0 font-mono text-[0.7rem]',
          tone === 'error' ? 'text-destructive/80' : 'text-muted-foreground',
        )}
      >
        {issue.code}
      </code>
      <span>{issue.message}</span>
    </>
  )

  if (!issue.node_id) {
    return <li className="flex items-baseline gap-2 px-1 py-0.5 text-sm">{content}</li>
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onFocusNode(issue.node_id as string)}
        className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left text-sm hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {content}
      </button>
    </li>
  )
}

export function ValidationBanner({ validation, onDismiss, onFocusNode }: ValidationBannerProps) {
  const { errors, warnings, valid } = validation

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2.5 border-b px-4 py-2.5',
        errors.length > 0 ? 'bg-destructive/5' : valid ? 'bg-kind-input/5' : 'bg-muted',
      )}
    >
      {errors.length > 0 ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      ) : warnings.length > 0 ? (
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-kind-input" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {errors.length > 0
            ? `${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} to fix`
            : warnings.length > 0
              ? `Valid, with ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`
              : 'This workflow is valid'}
        </p>

        {(errors.length > 0 || warnings.length > 0) && (
          <ul className="mt-1 space-y-0.5">
            {errors.map((issue, index) => (
              <IssueRow key={`e-${index}`} issue={issue} tone="error" onFocusNode={onFocusNode} />
            ))}
            {warnings.map((issue, index) => (
              <IssueRow key={`w-${index}`} issue={issue} tone="warning" onFocusNode={onFocusNode} />
            ))}
          </ul>
        )}
      </div>

      <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss validation">
        <X aria-hidden />
      </Button>
    </div>
  )
}
