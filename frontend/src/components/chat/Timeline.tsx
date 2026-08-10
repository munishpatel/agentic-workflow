import { useState } from 'react'
import { AlertTriangle, ChevronRight, Loader2, ShieldAlert } from 'lucide-react'
import type { TimelineView } from '@/types/ui'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { EdgeTransferChip } from '@/components/chat/EdgeTransferChip'
import { TimelineNodeGroup } from '@/components/chat/TimelineNodeGroup'
import { summariseTimeline } from '@/lib/events'
import { cn, formatMs, formatTokens } from '@/lib/utils'

interface TimelineProps {
  view: TimelineView
  /** node_id → label, from the saved workflow. */
  labels?: Record<string, string>
  /** tool id → display name. */
  toolNames?: Record<string, string>
  defaultOpen?: boolean
}

/**
 * The intermediate steps of a run: node groups, the data moving between them,
 * tool calls, router decisions. Collapsed by default so it never competes with
 * the answer it belongs to.
 */
export function Timeline({ view, labels = {}, toolNames, defaultOpen = false }: TimelineProps) {
  const [open, setOpen] = useState(defaultOpen)

  // A transfer's target usually has not started yet, so labels come from the
  // saved graph first and the observed steps only as a fallback.
  const resolved: Record<string, string> = { ...labels }
  for (const step of view.steps) {
    if (step.kind === 'node' && !resolved[step.nodeId]) resolved[step.nodeId] = step.label
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <span className="font-medium">{summariseTimeline(view)}</span>
        {view.durationMs > 0 && <span>· {formatMs(view.durationMs)}</span>}
        {view.usage.output_tokens > 0 && (
          <span>
            · {formatTokens(view.usage.input_tokens)} in / {formatTokens(view.usage.output_tokens)}{' '}
            out
          </span>
        )}
        {view.status === 'running' && (
          <Loader2 className="ml-auto size-3.5 animate-spin" aria-hidden />
        )}
        {/* Not a spinner: a paused run is not working on anything, and one that
            keeps spinning while it waits reads as a hang. */}
        {view.status === 'paused' && (
          <ShieldAlert
            className="ml-auto size-3.5 text-amber-600 dark:text-amber-500"
            aria-label="Waiting for approval"
          />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t bg-background px-3 py-3">
          {view.steps.map((step) =>
            step.kind === 'node' ? (
              <TimelineNodeGroup key={step.id} step={step} toolNames={toolNames} />
            ) : (
              <EdgeTransferChip key={step.id} step={step} labels={resolved} />
            ),
          )}

          {view.error && (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden />
              <AlertTitle className="font-mono text-xs">{view.error.code}</AlertTitle>
              <AlertDescription>{view.error.message}</AlertDescription>
            </Alert>
          )}

          {view.steps.length === 0 && !view.error && (
            <p className="text-sm text-muted-foreground">No steps recorded for this run.</p>
          )}
        </div>
      )}
    </div>
  )
}
