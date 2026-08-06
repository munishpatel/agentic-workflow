import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ChatTurn } from '@/types/api'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorState } from '@/components/common/ErrorState'
import { Composer } from '@/components/chat/Composer'
import { MessageList } from '@/components/chat/MessageList'
import { PastRunsSheet } from '@/components/chat/PastRunsSheet'
import { useChatSession } from '@/hooks/useChatSession'
import { ApiError, describeError } from '@/lib/client'
import { reduceEvents } from '@/lib/events'
import { useRunWorkflow, useTools, useWorkflow, useWorkflows } from '@/lib/queries'
import { createId, formatMs, formatTokens } from '@/lib/utils'

export function ChatPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const workflow = useWorkflow(id)
  const workflows = useWorkflows()
  const tools = useTools()
  const runWorkflow = useRunWorkflow()
  const { messages, setMessages, clear } = useChatSession(id)

  const labels = useMemo(() => {
    const map: Record<string, string> = {}
    for (const node of workflow.data?.nodes ?? []) map[node.id] = node.label
    return map
  }, [workflow.data])

  const toolNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const tool of tools.data ?? []) map[tool.id] = tool.name
    return map
  }, [tools.data])

  const totals = useMemo(() => {
    let tokens = 0
    let ms = 0
    for (const message of messages) {
      if (!message.usage) continue
      tokens += message.usage.input_tokens + message.usage.output_tokens
      ms += message.durationMs ?? 0
    }
    return { tokens, ms }
  }, [messages])

  function handleSend(text: string) {
    const history: ChatTurn[] = messages
      .filter((message) => message.status === 'ok' && message.content)
      .map((message) => ({ role: message.role, content: message.content }))

    const pendingId = createId('m')
    setMessages((previous) => [
      ...previous,
      { id: createId('m'), role: 'user', content: text, status: 'ok' },
      { id: pendingId, role: 'assistant', content: '', status: 'pending' },
    ])

    runWorkflow.mutate(
      { id, request: { message: text, history } },
      {
        onSuccess: (run) => {
          const view = reduceEvents(run.events)
          // A run can fail *inside* a 200 — a refusal, say. The event log is
          // the source of truth for whether the answer is usable.
          const failure = view.error
            ? describeError(new ApiError(200, view.error.code, view.error.message))
            : null

          setMessages((previous) =>
            previous.map((message) =>
              message.id === pendingId
                ? {
                    ...message,
                    content: run.final_response,
                    runId: run.run_id,
                    events: run.events,
                    usage: run.usage,
                    durationMs: run.duration_ms,
                    status: failure ? 'error' : 'ok',
                    ...(failure ? { error: failure } : {}),
                  }
                : message,
            ),
          )
        },
        onError: (error) => {
          const described = describeError(error)
          toast.error(described.title, { description: described.description })
          setMessages((previous) =>
            previous.map((message) =>
              message.id === pendingId
                ? { ...message, status: 'error', error: described }
                : message,
            ),
          )
        },
      },
    )
  }

  if (workflow.isPending) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="ml-auto h-7 w-24" />
        </header>
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-6">
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    )
  }

  if (workflow.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState error={workflow.error} onRetry={() => void workflow.refetch()} />
        <Button asChild variant="outline" className="mt-4">
          <Link to="/">Back to workflows</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4">
        <Select value={id} onValueChange={(next) => void navigate(`/workflows/${next}/chat`)}>
          <SelectTrigger className="w-auto min-w-48 border-0 px-2 font-medium shadow-none hover:bg-muted">
            <SelectValue aria-label={workflow.data.name}>{workflow.data.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(workflows.data ?? []).map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="hidden text-xs text-muted-foreground sm:inline">
          {workflow.data.model}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {totals.tokens > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden cursor-default text-xs text-muted-foreground tabular-nums md:inline">
                  {formatTokens(totals.tokens)} tokens · {formatMs(totals.ms)}
                </span>
              </TooltipTrigger>
              <TooltipContent>Totals for this chat session</TooltipContent>
            </Tooltip>
          )}
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear}>
              <Trash2 aria-hidden />
              Clear
            </Button>
          )}
          <PastRunsSheet workflowId={id} labels={labels} toolNames={toolNames} />
          <Button asChild variant="outline" size="sm">
            <Link to={`/workflows/${id}/edit`}>
              <Pencil aria-hidden />
              Edit
            </Link>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <MessageList messages={messages} labels={labels} toolNames={toolNames} />
        </div>
      </div>

      <div className="shrink-0 border-t bg-background px-6 py-3">
        <div className="mx-auto max-w-3xl">
          <Composer
            onSend={handleSend}
            disabled={runWorkflow.isPending}
            placeholder={`Message ${workflow.data.name}…`}
          />
          <p className="mt-1.5 text-center text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </p>
        </div>
      </div>
    </div>
  )
}
