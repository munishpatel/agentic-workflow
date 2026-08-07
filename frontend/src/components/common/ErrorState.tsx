import { AlertTriangle, RotateCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/client'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  className?: string
}

/**
 * Inline failure surface. It reads the error's `code` through `describeError`,
 * so `missing_api_key` and friends explain themselves instead of leaking a
 * status number at the user.
 */
export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const { title, description } = describeError(error)
  return (
    <Alert variant="destructive" className={cn('items-center', className)}>
      <AlertTriangle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      {description && <AlertDescription>{description}</AlertDescription>}
      {onRetry && (
        <div className="mt-2 flex">
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </div>
      )}
    </Alert>
  )
}
