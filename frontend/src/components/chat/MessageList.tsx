import { useEffect, useRef } from 'react'
import { MessagesSquare } from 'lucide-react'
import type { ChatMessage } from '@/types/ui'
import { EmptyState } from '@/components/common/EmptyState'
import { MessageBubble } from '@/components/chat/MessageBubble'

interface MessageListProps {
  messages: ChatMessage[]
  labels?: Record<string, string>
  toolNames?: Record<string, string>
  emptyHint?: string
}

export function MessageList({ messages, labels, toolNames, emptyHint }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const firstAssistantId = messages.find((message) => message.role === 'assistant')?.id

  if (messages.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title="Start the conversation"
        description={
          emptyHint ??
          'Send a message and the workflow runs. You’ll see the answer first, with every node, tool call and routing decision underneath it.'
        }
        className="my-8"
      />
    )
  }

  return (
    <div className="space-y-6">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          labels={labels}
          toolNames={toolNames}
          expandTimeline={message.id === firstAssistantId}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
