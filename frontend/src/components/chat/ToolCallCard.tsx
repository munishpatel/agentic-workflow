import { useState } from 'react'
import { AlertCircle, ChevronRight, Loader2, Wrench } from 'lucide-react'
import type { ToolEntry } from '@/types/ui'
import { cn, formatJson, formatMs } from '@/lib/utils'

const OUTPUT_LIMIT = 600

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  return formatJson(output)
}

interface ToolCallCardProps {
  entry: ToolEntry
  /** Tool id → display name, from GET /api/tools. Falls back to the id. */
  toolNames?: Record<string, string>
}

export function ToolCallCard({ entry, toolNames }: ToolCallCardProps) {
  const [showInput, setShowInput] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const name = toolNames?.[entry.tool] ?? entry.tool
  const result = entry.output === undefined ? '' : outputText(entry.output)
  const truncated = !expanded && result.length > OUTPUT_LIMIT
  const shown = truncated ? `${result.slice(0, OUTPUT_LIMIT)}…` : result

  return (
    <div
      className={cn(
        'rounded-lg border bg-card',
        entry.isError && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {entry.pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : entry.isError ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-kind-tool" aria-hidden />
        )}
        <span className="text-sm font-medium">{name}</span>
        {entry.isError && <span className="text-xs text-destructive">failed</span>}
        <button
          type="button"
          onClick={() => setShowInput((open) => !open)}
          aria-expanded={showInput}
          className="ml-auto flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronRight
            className={cn('size-3 transition-transform', showInput && 'rotate-90')}
            aria-hidden
          />
          input
        </button>
        {entry.ms !== undefined && (
          <span className="text-xs tabular-nums text-muted-foreground">{formatMs(entry.ms)}</span>
        )}
      </div>

      {showInput && (
        <pre className="mx-2.5 mb-2 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {formatJson(entry.input)}
        </pre>
      )}

      {!entry.pending && result && (
        <div className="border-t px-2.5 py-1.5">
          <pre
            className={cn(
              'overflow-x-auto font-mono text-xs whitespace-pre-wrap',
              entry.isError ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {shown}
          </pre>
          {result.length > OUTPUT_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              className="mt-1 rounded-sm text-xs font-medium text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {expanded ? 'Show less' : `Show all ${result.length} characters`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
