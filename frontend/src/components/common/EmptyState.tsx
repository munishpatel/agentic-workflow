import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: ReactNode
  action?: ReactNode
  className?: string
}

/** Every list in the app has one of these — see the conventions in §10. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center',
        className,
      )}
    >
      <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <h2 className="text-base font-medium">{title}</h2>
      <div className="mt-1.5 max-w-md text-sm text-balance text-muted-foreground">
        {description}
      </div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
