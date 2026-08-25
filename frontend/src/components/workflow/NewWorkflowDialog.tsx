import { useEffect, useMemo } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToolPicker } from '@/components/builder/ToolPicker'
import { ApiError, describeError } from '@/lib/client'
import { useNodeKinds } from '@/lib/queries'
import { describeSchema } from '@/lib/jsonSchema'
import type { NewWorkflowValues } from '@/lib/workflowDefaults'

// Defined alongside the mapping that consumes it, so the two cannot drift.
export type { NewWorkflowValues }

const EMPTY: NewWorkflowValues = {
  name: '',
  description: '',
  useDefaults: true,
  systemPrompt: '',
  toolsEnabled: false,
  tools: [],
}

interface NewWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Rejecting lands the failure here — a duplicate name is shown inline, anything else as a toast. */
  onSubmit: (values: NewWorkflowValues) => Promise<void>
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
  const form = useForm<NewWorkflowValues>({ defaultValues: EMPTY })
  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    setValue,
    setError,
    formState: { errors },
  } = form

  async function submit(values: NewWorkflowValues) {
    try {
      await onSubmit(values)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'duplicate_name') {
        setError('name', { type: 'manual', message: error.message })
        return
      }
      const { title, description } = describeError(error)
      toast.error(title, { description })
    }
  }

  const useDefaults = watch('useDefaults')
  const toolsEnabled = watch('toolsEnabled')

  // The ids the agent kind's schema actually allows, read the same way the
  // builder reads them — so a tool added on the backend appears here too.
  const nodeKinds = useNodeKinds()
  const allowedTools = useMemo(() => {
    const agent = nodeKinds.data?.find((kind) => kind.kind === 'agent')
    if (!agent) return []
    const field = describeSchema(agent.config_schema).find((entry) => entry.name === 'tools')
    return (field?.options ?? []).map((option) => option.value)
  }, [nodeKinds.data])

  // Reopening should not show the previous attempt's text or errors.
  useEffect(() => {
    if (open) reset(EMPTY)
  }, [open, reset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit(submit)} noValidate>
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
            <DialogDescription>
              Name it, then either take the defaults or set up the agent now.
            </DialogDescription>
          </DialogHeader>

          <div className="my-5 grid max-h-[60vh] gap-4 overflow-y-auto px-0.5">
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
                rows={2}
                placeholder="What is this workflow for? Shown on its card."
                {...register('description')}
              />
            </div>

            {/*
              Checked by default: creating a workflow stays one field and a
              click, and everything below is reachable in the builder anyway.
              Unchecking is the opt-in, not the other way round.
            */}
            <Controller
              control={control}
              name="useDefaults"
              render={({ field }) => (
                <label
                  htmlFor="workflow-defaults"
                  className="flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors hover:bg-muted/60"
                >
                  <Checkbox
                    id="workflow-defaults"
                    checked={field.value}
                    onCheckedChange={(next) => field.onChange(next === true)}
                    className="mt-0.5"
                  />
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    Start with a runnable{' '}
                    <code className="font-mono text-foreground">input → agent → output</code> graph.
                    You can add routers, tools and more agents in the builder later.
                  </span>
                </label>
              )}
            />

            {!useDefaults && (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="workflow-system-prompt">System prompt</Label>
                  <Textarea
                    id="workflow-system-prompt"
                    rows={3}
                    placeholder="You are a helpful assistant. Be accurate, be brief, and say plainly when you are unsure."
                    {...register('systemPrompt')}
                  />
                  <p className="text-xs text-muted-foreground">
                    Sets the tone and rules for every agent in this workflow. Leave empty for the
                    default.
                  </p>
                </div>

                <div className="grid gap-2.5">
                  <Controller
                    control={control}
                    name="toolsEnabled"
                    render={({ field }) => (
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="workflow-tools-enabled" className="font-normal">
                          Tools
                          <span className="block text-xs font-normal text-muted-foreground">
                            Let the agent call tools to answer.
                          </span>
                        </Label>
                        <Switch
                          id="workflow-tools-enabled"
                          checked={field.value}
                          onCheckedChange={(next) => {
                            field.onChange(next)
                            // Turning tools off should not leave a stale
                            // selection to be silently re-applied on re-enable.
                            if (!next) setValue('tools', [])
                          }}
                        />
                      </div>
                    )}
                  />

                  {toolsEnabled && (
                    <Controller
                      control={control}
                      name="tools"
                      render={({ field }) => (
                        <ToolPicker
                          value={field.value}
                          onChange={field.onChange}
                          allowed={allowedTools}
                          idPrefix="new-workflow"
                          compact
                        />
                      )}
                    />
                  )}
                </div>
              </>
            )}
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
