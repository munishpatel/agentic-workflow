import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  MessagesSquare,
  Redo2,
  Save,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface BuilderTopBarProps {
  name: string
  isDirty: boolean
  saving: boolean
  validating: boolean
  canUndo: boolean
  canRedo: boolean
  onSave: () => void
  onValidate: () => void
  onUndo: () => void
  onRedo: () => void
  onOpenChat: () => void
}

export function BuilderTopBar({
  name,
  isDirty,
  saving,
  validating,
  canUndo,
  canRedo,
  onSave,
  onValidate,
  onUndo,
  onRedo,
  onOpenChat,
}: BuilderTopBarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <Link
          to="/"
          className="rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Workflows
        </Link>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-medium">{name || 'Untitled'}</span>
      </nav>

      {isDirty ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-kind-tool" aria-hidden />
          Unsaved changes
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3" aria-hidden />
          Saved
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label="Undo"
            >
              <Undo2 aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo (⌘Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRedo}
              disabled={!canRedo}
              aria-label="Redo"
            >
              <Redo2 aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo (⇧⌘Z)</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button variant="outline" size="sm" onClick={onValidate} disabled={validating}>
          {validating ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <ShieldCheck aria-hidden />
          )}
          Validate
        </Button>
        <Button size="sm" onClick={onSave} disabled={!isDirty || saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
          Save
        </Button>
        <Button variant="outline" size="sm" onClick={onOpenChat}>
          <MessagesSquare aria-hidden />
          Chat
        </Button>
      </div>
    </header>
  )
}
