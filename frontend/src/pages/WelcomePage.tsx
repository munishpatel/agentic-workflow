import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Inbox, MessagesSquare, Plus, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { NewWorkflowDialog, type NewWorkflowValues } from '@/components/workflow/NewWorkflowDialog'
import { describeError } from '@/lib/client'
import { useCreateWorkflow, useProviders } from '@/lib/queries'
import { newWorkflowInput } from '@/lib/workflowDefaults'

const FEATURES = [
  {
    to: '/workflows',
    icon: Workflow,
    title: 'Visual canvas',
    description: 'Drag nodes onto the graph and wire them together to shape how an agent behaves.',
  },
  {
    to: '/workflows',
    icon: MessagesSquare,
    title: 'Chat preview',
    description: 'Run a workflow as a live conversation before it ever reaches a real user.',
  },
  {
    to: '/outbox',
    icon: Inbox,
    title: 'Delivery outbox',
    description: 'See every message a workflow sent, replayed exactly as it went out.',
  },
]

export function WelcomePage() {
  const navigate = useNavigate()
  const providers = useProviders()
  const createWorkflow = useCreateWorkflow()
  const [dialogOpen, setDialogOpen] = useState(false)

  function handleCreate(values: NewWorkflowValues) {
    const provider = providers.data?.[0]
    createWorkflow.mutate(
      newWorkflowInput({
        name: values.name.trim(),
        description: values.description,
        provider: provider?.id,
        model: provider?.models[0],
      }),
      {
        onSuccess: (workflow) => {
          setDialogOpen(false)
          toast.success(`Created “${workflow.name}”`)
          void navigate(`/workflows/${workflow.id}/edit`)
        },
        onError: (error) => {
          const { title, description } = describeError(error)
          toast.error(title, { description })
        },
      },
    )
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-16 text-center">
      <h1 className="text-5xl font-semibold tracking-tight text-balance">Workflow Studio</h1>
      <p className="mt-4 max-w-xl text-lg text-muted-foreground text-balance">
        A full featured visual builder for agent workflows — create, test, and ship at the speed of
        drag &amp; drop.
      </p>

      <Button size="lg" className="mt-8" onClick={() => setDialogOpen(true)}>
        <Plus aria-hidden />
        New Workflow
      </Button>

      <div className="mt-16 rounded-xl border bg-card px-8 py-10 text-left">
        <p className="text-sm font-semibold text-primary">Drag. Drop. Ship faster.</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight">Visual Canvas</p>
        <p className="mt-3 max-w-lg text-sm text-muted-foreground">
          Compose nodes for models, tools, and control flow on one graph, then connect them by
          drawing edges between handles — no config file required.
        </p>
      </div>

      <div className="mt-10 grid w-full gap-4 text-left sm:grid-cols-3">
        {FEATURES.map(({ to, icon: Icon, title, description }) => (
          <Link key={title} to={to} className="block rounded-xl focus-visible:outline-none">
            <Card className="h-full transition-colors hover:bg-muted/50">
              <CardHeader>
                <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <CardTitle className="mt-2">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <NewWorkflowDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        pending={createWorkflow.isPending}
      />
    </div>
  )
}
