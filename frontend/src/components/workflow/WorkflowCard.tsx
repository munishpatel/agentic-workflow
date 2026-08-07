import { Link } from 'react-router-dom'
import { Copy, MessagesSquare, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import type { ToolMeta, WorkflowSummary } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatRelativeTime, pluralise } from '@/lib/utils'

interface WorkflowCardProps {
  workflow: WorkflowSummary
  tools: ToolMeta[]
  onDuplicate: (id: string) => void
  onDelete: (workflow: WorkflowSummary) => void
  busy?: boolean
}

export function WorkflowCard({
  workflow,
  tools,
  onDuplicate,
  onDelete,
  busy = false,
}: WorkflowCardProps) {
  const toolNames = workflow.tool_ids.map((id) => tools.find((tool) => tool.id === id)?.name ?? id)

  return (
    <Card className="transition-shadow hover:ring-foreground/20">
      <CardHeader>
        <CardTitle className="truncate">
          <Link
            to={`/workflows/${workflow.id}/chat`}
            className="rounded-sm hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {workflow.name}
          </Link>
        </CardTitle>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${workflow.name}`}
                disabled={busy}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to={`/workflows/${workflow.id}/edit`}>
                  <Pencil aria-hidden />
                  Edit
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDuplicate(workflow.id)}>
                <Copy aria-hidden />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(workflow)}>
                <Trash2 aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
        <CardDescription className="line-clamp-2 min-h-10">
          {workflow.description ?? 'No description.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {workflow.model}
        </Badge>
        <Badge variant="secondary">{pluralise(workflow.node_count, 'node')}</Badge>
        {toolNames.slice(0, 2).map((name) => (
          <Badge key={name} variant="secondary">
            {name}
          </Badge>
        ))}
        {toolNames.length > 2 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary">+{toolNames.length - 2}</Badge>
            </TooltipTrigger>
            <TooltipContent>{toolNames.slice(2).join(', ')}</TooltipContent>
          </Tooltip>
        )}
        {toolNames.length === 0 && (
          <span className="text-xs text-muted-foreground">No tools enabled</span>
        )}
      </CardContent>

      <CardFooter className="justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Edited {formatRelativeTime(workflow.updated_at)}
        </span>
        <div className="flex items-center gap-1.5">
          <Button asChild variant="outline" size="sm">
            <Link to={`/workflows/${workflow.id}/edit`}>
              <Pencil aria-hidden />
              Edit
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link to={`/workflows/${workflow.id}/chat`}>
              <MessagesSquare aria-hidden />
              Chat
            </Link>
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
