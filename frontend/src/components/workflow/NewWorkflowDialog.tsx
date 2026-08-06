import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export interface NewWorkflowValues {
  name: string
  description: string
}

interface NewWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: NewWorkflowValues) => void
  pending: boolean
  trigger?: React.ReactNode
}

export function NewWorkflowDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
  trigger,
}: NewWorkflowDialogProps) {
  const form = useForm<NewWorkflowValues>({ defaultValues: { name: '', description: '' } })
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = form

  // Reopening should not show the previous attempt's text or errors.
  useEffect(() => {
    if (open) reset({ name: '', description: '' })
  }, [open, reset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>
              It starts as a runnable <code className="font-mono">input → agent → output</code>{' '}
              graph. You can add routers, tools and more agents in the builder.
            </DialogDescription>
          </DialogHeader>

          <div className="my-5 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="workflow-name">Name</Label>
              <Input
                id="workflow-name"
                autoFocus
                placeholder="Research assistant"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'workflow-name-error' : undefined}
                {...register('name', {
                  required: 'Give the workflow a name.',
                  maxLength: { value: 80, message: 'Keep it under 80 characters.' },
                })}
              />
              {errors.name && (
                <p id="workflow-name-error" className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="workflow-description">Description</Label>
              <Textarea
                id="workflow-description"
                rows={3}
                placeholder="What is this workflow for? Shown on its card."
                {...register('description')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
              Create workflow
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
