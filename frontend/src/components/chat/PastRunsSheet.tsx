import { useState } from 'react'
import { ChevronLeft, History, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { Skeleton } from '@/components/ui/skeleton'
import { Timeline } from '@/components/chat/Timeline'
import { RichText } from '@/lib/richText'
import { reduceEvents } from '@/lib/events'
import { useRun, useWorkflowRuns } from '@/lib/queries'
import { formatMs, formatRelativeTime, truncate } from '@/lib/utils'

interface PastRunsSheetProps {
  workflowId: string
  labels?: Record<string, string>
  toolNames?: Record<string, string>
}

/**
 * Replay. A stored run's events go through the same `reduceEvents` and the same
 * `Timeline` as a live one — that shared path is the point, not a shortcut.
 */
function RunReplay({
  runId,
  labels,
  toolNames,
}: {
  runId: string
  labels?: Record<string, string>
  toolNames?: Record<string, string>
}) {
  const run = useRun(runId)

  if (run.isPending) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (run.isError) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />

  const view = reduceEvents(run.data.events)
  return (
    <div>
      {run.data.final_response ? (
        <RichText text={run.data.final_response} className="text-sm" />
      ) : (
        <p className="text-sm text-muted-foreground">This run produced no reply.</p>
      )}
      <Timeline view={view} labels={labels} toolNames={toolNames} defaultOpen />
    </div>
  )
}

export function PastRunsSheet({ workflowId, labels, toolNames }: PastRunsSheetProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const runs = useWorkflowRuns(workflowId, open)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSelected(null)
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <History aria-hidden />
          Past runs
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {selected ? (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex items-center gap-1 rounded-sm hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <ChevronLeft className="size-4" aria-hidden />
                All runs
              </button>
            ) : (
              'Past runs'
            )}
          </SheetTitle>
          <SheetDescription>
            Stored runs replay through the same reducer as a live one.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {selected ? (
            <RunReplay runId={selected} labels={labels} toolNames={toolNames} />
          ) : runs.isPending ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : runs.isError ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : runs.data.length === 0 ? (
            <EmptyState
              icon={History}
              title="No runs yet"
              description="Every message you send is stored with its full event log, and shows up here."
            />
          ) : (
            <ul className="space-y-1.5">
              {runs.data.map((run) => (
                <li key={run.run_id}>
                  <button
                    type="button"
                    onClick={() => setSelected(run.run_id)}
                    className="w-full rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <p className="truncate text-sm font-medium">{run.user_message}</p>
                    <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                      {truncate(run.final_response, 120) || 'No reply'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatRelativeTime(run.created_at)} · {formatMs(run.duration_ms)} ·{' '}
                      {run.usage.input_tokens + run.usage.output_tokens} tokens
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {runs.isFetching && !runs.isPending && (
          <div className="flex items-center gap-1.5 border-t px-4 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Refreshing…
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
