import { CircleSlash, Loader2, SkipForward } from 'lucide-react'
import type { LlmEntry, NodeStep } from '@/types/ui'
import { RouteDecisionCard } from '@/components/chat/RouteDecisionCard'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import { nodeKindVisual } from '@/lib/nodeVisuals'
import { RichText } from '@/lib/richText'
import { cn, formatMs, formatTokens } from '@/lib/utils'

function LlmLine({ entry }: { entry: LlmEntry }) {
  return (
    <p className="text-xs text-muted-foreground">
      Model call {entry.iteration} · {formatTokens(entry.usage.input_tokens)} in /{' '}
      {formatTokens(entry.usage.output_tokens)} out · {entry.stopReason.replace('_', ' ')}
    </p>
  )
}

export function TimelineNodeGroup({
  step,
  toolNames,
}: {
  step: NodeStep
  toolNames?: Record<string, string>
}) {
  const visual = nodeKindVisual(step.nodeKind)
  const skipped = step.status === 'skipped'
  const failed = step.status === 'failed'
  const Icon = skipped ? SkipForward : failed ? CircleSlash : visual.icon

  return (
    <div className={cn('flex gap-2.5', skipped && 'opacity-60')}>
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md',
          skipped && 'bg-muted text-muted-foreground',
          failed && 'bg-destructive/10 text-destructive',
          !skipped && !failed && cn(visual.bg, visual.text),
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{step.label}</span>
          <span className="text-xs text-muted-foreground">{step.nodeKind}</span>
          {step.status === 'running' && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              running
            </span>
          )}
          {failed && <span className="text-xs text-destructive">stopped here</span>}
          {step.ms !== undefined && (
            <span className="text-xs tabular-nums text-muted-foreground">{formatMs(step.ms)}</span>
          )}
        </div>

        {skipped && step.reason && (
          <p className="mt-0.5 text-xs text-muted-foreground">Skipped — {step.reason}</p>
        )}

        {step.entries.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {step.entries.map((entry, index) => {
              switch (entry.type) {
                case 'tool':
                  return (
                    <ToolCallCard
                      key={`${entry.callId}-${index}`}
                      entry={entry}
                      toolNames={toolNames}
                    />
                  )
                case 'route':
                  return <RouteDecisionCard key={index} entry={entry} />
                case 'llm':
                  return <LlmLine key={index} entry={entry} />
                case 'message':
                  return (
                    <div
                      key={index}
                      className="rounded-lg border bg-card px-2.5 py-1.5 text-sm text-muted-foreground"
                    >
                      <RichText text={entry.text} />
                      {entry.partial && (
                        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground align-middle" />
                      )}
                    </div>
                  )
              }
            })}
          </div>
        )}
      </div>
    </div>
  )
}
