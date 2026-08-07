import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold tracking-tight">This page doesn’t exist</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The workflow may have been deleted, or the link is wrong.
      </p>
      <Button asChild className="mt-2">
        <Link to="/workflows">Back to workflows</Link>
      </Button>
    </div>
  )
}
