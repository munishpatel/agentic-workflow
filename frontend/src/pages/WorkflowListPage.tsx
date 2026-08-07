import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Plus, Workflow as WorkflowIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { WorkflowSummary } from '@/types/api'
import { EmptyState } from '@/components/common/EmptyState'
import { ErrorState } from '@/components/common/ErrorState'
import { PageHeader } from '@/components/common/PageHeader'
import { NewWorkflowDialog, type NewWorkflowValues } from '@/components/workflow/NewWorkflowDialog'
import { WorkflowCard } from '@/components/workflow/WorkflowCard'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError } from '@/lib/client'
import {
  useCreateWorkflow,
  useDeleteWorkflow,
  useDuplicateWorkflow,
  useProviders,
  useTools,
  useWorkflows,
} from '@/lib/queries'
import { workflowInputFromDialog } from '@/lib/workflowDefaults'

function reportError(error: unknown) {
  const { title, description } = describeError(error)
  toast.error(title, { description })
}

export function WorkflowListPage() {
  const navigate = useNavigate()
  const workflows = useWorkflows()
  const tools = useTools()
  const providers = useProviders()

  const createWorkflow = useCreateWorkflow()
  const duplicateWorkflow = useDuplicateWorkflow()
  const deleteWorkflow = useDeleteWorkflow()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<WorkflowSummary | null>(null)

  function handleCreate(values: NewWorkflowValues) {
    const provider = providers.data?.[0]
    createWorkflow.mutate(workflowInputFromDialog(values, provider), {
      onSuccess: (workflow) => {
        setDialogOpen(false)
        toast.success(`Created “${workflow.name}”`)
        void navigate(`/workflows/${workflow.id}/edit`)
      },
      onError: reportError,
    })
  }

  function handleDuplicate(id: string) {
    duplicateWorkflow.mutate(id, {
      onSuccess: (workflow) => toast.success(`Duplicated as “${workflow.name}”`),
      onError: reportError,
    })
  }

  function handleConfirmDelete() {
    if (!pendingDelete) return
    const { id, name } = pendingDelete
    deleteWorkflow.mutate(id, {
      onSuccess: () => toast.success(`Deleted “${name}”`),
      onError: reportError,
    })
    setPendingDelete(null)
  }

  const newButton = (
    <Button onClick={() => setDialogOpen(true)}>
      <Plus aria-hidden />
      New workflow
    </Button>
  )

  return (
    <div className="mx-auto h-full max-w-6xl overflow-y-auto p-6">
      <PageHeader
        title="Workflows"
        description="Configure a graph of agents, tools and routers — then chat with it."
        actions={
          <>
            {duplicateWorkflow.isPending && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Duplicating…
              </span>
            )}
            {newButton}
          </>
        }
      />

      {workflows.isPending && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
          {Array.from({ length: 3 }, (_, index) => (
            <Card key={index}>
              <CardHeader className="gap-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </CardHeader>
              <CardContent className="flex gap-1.5">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </CardContent>
              <CardFooter className="justify-between">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-28" />
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {workflows.isError && (
        <ErrorState error={workflows.error} onRetry={() => void workflows.refetch()} />
      )}

      {workflows.isSuccess && workflows.data.length === 0 && (
        <EmptyState
          icon={WorkflowIcon}
          title="No workflows yet"
          description={
            <>
              A workflow is a saved graph: an entry point, agents with their own instructions and
              tools, optional routers for branching, and one output. Build it once, then chat with
              it as often as you like.
            </>
          }
          action={newButton}
        />
      )}

      {workflows.isSuccess && workflows.data.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.data.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              tools={tools.data ?? []}
              onDuplicate={handleDuplicate}
              onDelete={setPendingDelete}
              busy={deleteWorkflow.isPending && deleteWorkflow.variables === workflow.id}
            />
          ))}
        </div>
      )}

      <NewWorkflowDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        pending={createWorkflow.isPending}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow and its saved run history are removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
