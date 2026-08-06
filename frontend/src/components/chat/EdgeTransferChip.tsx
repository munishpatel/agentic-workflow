import { ArrowRight } from 'lucide-react'
import type { TransferStep } from '@/types/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { portTypeColour, portTypeDot } from '@/lib/nodeVisuals'
import { cn, truncate } from '@/lib/utils'

interface EdgeTransferChipProps {
  step: TransferStep
  /** node_id → label. The graph knows names the event log only has ids for. */
  labels: Record<string, string>
}

/**
 * The visible payoff of the typed-connection model: data actually moving along
 * a declared port, with the value that crossed it one hover away.
 */
export function EdgeTransferChip({ step, labels }: EdgeTransferChipProps) {
  const source = labels[step.source.node_id] ?? step.source.node_id
  const target = labels[step.target.node_id] ?? step.target.node_id

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="ml-3 flex w-fit cursor-default items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{source}</span>
          <span className="font-mono opacity-70">{step.source.port}</span>
          <ArrowRight className="size-3" aria-hidden />
          <span className={cn('flex items-center gap-1', portTypeColour(step.portType))}>
            <span className={cn('size-1.5 rounded-full', portTypeDot(step.portType))} aria-hidden />
            {step.portType}
          </span>
          <ArrowRight className="size-3" aria-hidden />
          <span className="font-medium text-foreground">{target}</span>
          <span className="font-mono opacity-70">{step.target.port}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <p className="font-mono text-xs break-words whitespace-pre-wrap">
          {truncate(step.preview, 300) || '(empty)'}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}
