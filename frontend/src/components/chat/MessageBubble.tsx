import { useMemo } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { ChatMessage } from '@/types/ui'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Timeline } from '@/components/chat/Timeline'
import { reduceEvents } from '@/lib/events'
import { RichText } from '@/lib/richText'

interface MessageBubbleProps {
  message: ChatMessage
  labels?: Record<string, string>
  toolNames?: Record<string, string>
  /** The first assistant turn opens its timeline so the feature is discovered. */
  expandTimeline?: boolean
}

export function MessageBubble({
  message,
  labels,
  toolNames,
  expandTimeline = false,
}: MessageBubbleProps) {
  const view = useMemo(
    () => (message.events ? reduceEvents(message.events) : null),
    [message.events],
  )

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-full">
      {message.status === 'pending' && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Running…
        </div>
      )}

      {/* The answer is the primary content: first, largest, unmissable. The
          steps that produced it sit below and stay collapsed. */}
      {message.content && <RichText text={message.content} className="text-[0.95rem]" />}

      {message.status === 'error' && message.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>{message.error.title}</AlertTitle>
          {message.error.description && (
            <AlertDescription>{message.error.description}</AlertDescription>
          )}
        </Alert>
      )}

      {view && view.steps.length > 0 && (
        <Timeline view={view} labels={labels} toolNames={toolNames} defaultOpen={expandTimeline} />
      )}
    </div>
  )
}
