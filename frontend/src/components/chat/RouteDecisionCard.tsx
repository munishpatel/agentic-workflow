import { GitBranch } from 'lucide-react'
import type { RouteEntry } from '@/types/ui'
import { Badge } from '@/components/ui/badge'

export function RouteDecisionCard({ entry }: { entry: RouteEntry }) {
  const notTaken = entry.considered.filter((route) => route !== entry.chosen)

  return (
    <div className="rounded-lg border bg-card px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <GitBranch className="size-3.5 shrink-0 text-kind-router" aria-hidden />
        <span className="text-sm">Routed to</span>
        <Badge className="bg-kind-router/12 font-mono text-kind-router">{entry.chosen}</Badge>
        {notTaken.length > 0 && (
          <span className="text-xs text-muted-foreground">
            not <span className="font-mono">{notTaken.join(', ')}</span>
          </span>
        )}
      </div>
      {entry.reason && <p className="mt-1 text-sm text-muted-foreground">{entry.reason}</p>}
    </div>
  )
}
