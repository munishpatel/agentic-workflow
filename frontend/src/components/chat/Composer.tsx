import { useRef, useState, type KeyboardEvent } from 'react'
import { Loader2, SendHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface ComposerProps {
  onSend: (message: string) => void
  disabled?: boolean
  placeholder?: string
}

export function Composer({ onSend, disabled = false, placeholder }: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function submit() {
    const message = value.trim()
    if (!message || disabled) return
    onSend(message)
    setValue('')
    // Reset the auto-grown height along with the text.
    const textarea = textareaRef.current
    if (textarea) textarea.style.height = 'auto'
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      className="flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:ring-3 focus-within:ring-ring/30"
    >
      <Textarea
        ref={textareaRef}
        value={value}
        rows={1}
        onChange={(event) => {
          setValue(event.target.value)
          const textarea = event.target
          textarea.style.height = 'auto'
          textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label="Message"
        placeholder={placeholder ?? 'Ask the workflow something…'}
        className="max-h-50 min-h-9 resize-none border-0 bg-transparent px-1.5 py-1.5 shadow-none focus-visible:ring-0"
      />
      <Button type="submit" size="icon" disabled={disabled || !value.trim()} aria-label="Send">
        {disabled ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <SendHorizontal aria-hidden />
        )}
      </Button>
    </form>
  )
}
