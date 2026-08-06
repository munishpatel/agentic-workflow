import type { NodeKindSpec } from '@/types/api'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { nodeKindVisual } from '@/lib/nodeVisuals'
import { SINGLETON_KINDS } from '@/lib/workflowDefaults'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/store/editorStore'

interface NodePaletteProps {
  specs: NodeKindSpec[]
  loading?: boolean
  /** Where a click-to-add node should land. The canvas supplies its centre. */
  positionFor: () => { x: number; y: number }
}

/**
 * One button per published node kind. Nothing here is hardcoded per kind, so a
 * kind added on the backend shows up after a refresh.
 */
export function NodePalette({ specs, loading = false, positionFor }: NodePaletteProps) {
  const nodes = useEditorStore((state) => state.nodes)
  const addNode = useEditorStore((state) => state.addNode)

  if (loading) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {specs.map((spec) => {
        const visual = nodeKindVisual(spec.kind)
        const Icon = visual.icon
        const atCap =
          SINGLETON_KINDS.includes(spec.kind) && nodes.some((node) => node.kind === spec.kind)

        return (
          <Tooltip key={spec.kind}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={atCap}
                draggable={!atCap}
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-node-kind', spec.kind)
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onClick={() => addNode(spec, positionFor())}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors',
                  'hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-md',
                    visual.bg,
                    visual.text,
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <span className="truncate font-medium">{spec.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-56">
              {atCap ? `Only one ${spec.label.toLowerCase()} node per workflow.` : spec.description}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
