import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { List, Network, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BuilderTopBar } from '@/components/builder/BuilderTopBar'
import { GraphCanvas } from '@/components/builder/GraphCanvas'
import { GraphOutline } from '@/components/builder/GraphOutline'
import { NodeInspector } from '@/components/builder/NodeInspector'
import { NodePalette } from '@/components/builder/NodePalette'
import { ValidationBanner } from '@/components/builder/ValidationBanner'
import { WorkflowMetaForm } from '@/components/builder/WorkflowMetaForm'
import { ErrorState } from '@/components/common/ErrorState'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useEditorShortcuts } from '@/hooks/useEditorShortcuts'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { describeError } from '@/lib/client'
import { useNodeKinds, useUpdateWorkflow, useValidateWorkflow, useWorkflow } from '@/lib/queries'
import { selectSelectedNode, useEditorStore } from '@/store/editorStore'

export function WorkflowEditorPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()

  const workflow = useWorkflow(id)
  const nodeKinds = useNodeKinds()
  const updateWorkflow = useUpdateWorkflow()
  const validateWorkflow = useValidateWorkflow()

  const hydrate = useEditorStore((state) => state.hydrate)
  const markSaved = useEditorStore((state) => state.markSaved)
  const setValidation = useEditorStore((state) => state.setValidation)
  const select = useEditorStore((state) => state.select)
  const undo = useEditorStore((state) => state.undo)
  const redo = useEditorStore((state) => state.redo)

  const workflowId = useEditorStore((state) => state.workflowId)
  const isDirty = useEditorStore((state) => state.isDirty)
  const validation = useEditorStore((state) => state.validation)
  const metaName = useEditorStore((state) => state.meta.name)
  const canUndo = useEditorStore((state) => state.past.length > 0)
  const canRedo = useEditorStore((state) => state.future.length > 0)
  const selectedNode = useEditorStore(selectSelectedNode)

  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null)
  const [view, setView] = useState<'canvas' | 'outline'>('canvas')
  const [railOpen, setRailOpen] = useState(false)

  const wideEnoughForInspector = useMediaQuery('(min-width: 1024px)')
  const wideEnoughForRail = useMediaQuery('(min-width: 1280px)')

  // Query fetches → hydrate copies in once. Re-hydrating on every refetch would
  // throw away whatever the user has typed since.
  useEffect(() => {
    if (workflow.data && workflowId !== workflow.data.id) hydrate(workflow.data)
  }, [workflow.data, workflowId, hydrate])

  // Closing the tab is the one navigation the app cannot intercept itself.
  useEffect(() => {
    if (!isDirty) return
    const handler = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const handleSave = useCallback(() => {
    const input = useEditorStore.getState().toInput()
    if (!input.name.trim()) {
      toast.error('Give the workflow a name before saving.')
      return
    }
    updateWorkflow.mutate(
      { id, input },
      {
        onSuccess: (saved) => {
          markSaved(saved)
          toast.success('Workflow saved')
        },
        onError: (error) => {
          const { title, description } = describeError(error)
          toast.error(title, { description })
        },
      },
    )
  }, [id, updateWorkflow, markSaved])

  function handleValidate() {
    validateWorkflow.mutate(
      { id, input: useEditorStore.getState().toInput() },
      {
        onSuccess: setValidation,
        onError: (error) => {
          const { title, description } = describeError(error)
          toast.error(title, { description })
        },
      },
    )
  }

  /** Anything leaving the builder goes through here so edits are never lost. */
  function leaveTo(path: string) {
    if (useEditorStore.getState().isDirty) setPendingNavigation(path)
    else void navigate(path)
  }

  useEditorShortcuts({ onSave: handleSave })

  if (workflow.isPending) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-12 items-center gap-3 border-b px-4">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="ml-auto h-7 w-40" />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-60 shrink-0 space-y-3 border-r p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="flex-1 p-6">
            <Skeleton className="h-40 w-full max-w-3xl" />
          </div>
        </div>
      </div>
    )
  }

  if (workflow.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState error={workflow.error} onRetry={() => void workflow.refetch()} />
        <Button asChild variant="outline" className="mt-4">
          <Link to="/workflows">Back to workflows</Link>
        </Button>
      </div>
    )
  }

  // One definition, rendered either as a fixed rail or inside a sheet.
  const rail = (
    <>
      <WorkflowMetaForm />
      <div className="mt-6">
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">Add a node</h2>
        <NodePalette
          specs={nodeKinds.data ?? []}
          loading={nodeKinds.isPending}
          positionFor={() => {
            const current = useEditorStore.getState().nodes
            const right = Math.max(0, ...current.map((node) => node.position.x))
            return { x: right + 260, y: 200 }
          }}
        />
        {nodeKinds.isError && (
          <ErrorState
            error={nodeKinds.error}
            onRetry={() => void nodeKinds.refetch()}
            className="mt-2"
          />
        )}
      </div>
    </>
  )

  return (
    <div className="flex h-full flex-col">
      <BuilderTopBar
        name={metaName}
        isDirty={isDirty}
        saving={updateWorkflow.isPending}
        validating={validateWorkflow.isPending}
        canUndo={canUndo}
        canRedo={canRedo}
        onSave={handleSave}
        onValidate={handleValidate}
        onUndo={undo}
        onRedo={redo}
        onOpenChat={() => leaveTo(`/workflows/${id}/chat`)}
        onBack={() => leaveTo('/workflows')}
      />

      {validation && (
        <ValidationBanner
          validation={validation}
          onDismiss={() => setValidation(null)}
          onFocusNode={select}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {wideEnoughForRail && (
          <aside
            className="w-60 shrink-0 overflow-y-auto border-r p-4"
            aria-label="Workflow settings"
          >
            {rail}
          </aside>
        )}

        {/* Two views of one draft. The canvas is the headline; the outline is
            how the graph is edited without a mouse. */}
        <Tabs
          value={view}
          onValueChange={(next) => setView(next as 'canvas' | 'outline')}
          className="flex min-w-0 flex-1 flex-col gap-0"
        >
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
            {!wideEnoughForRail && (
              <Button variant="outline" size="sm" onClick={() => setRailOpen(true)}>
                <SlidersHorizontal aria-hidden />
                Settings
              </Button>
            )}
            <TabsList>
              <TabsTrigger value="canvas">
                <Network aria-hidden />
                Canvas
              </TabsTrigger>
              <TabsTrigger value="outline">
                <List aria-hidden />
                Outline
              </TabsTrigger>
            </TabsList>
            <p className="hidden text-xs text-muted-foreground xl:block">
              {view === 'canvas'
                ? 'Drag a kind from the palette. Connect an output handle to an input handle.'
                : 'Every graph edit, without a pointer.'}
            </p>
          </div>

          <TabsContent value="canvas" className="min-h-0 flex-1">
            <GraphCanvas specs={nodeKinds.data ?? []} />
          </TabsContent>
          <TabsContent value="outline" className="min-h-0 flex-1 overflow-y-auto">
            <GraphOutline specs={nodeKinds.data ?? []} />
          </TabsContent>
        </Tabs>

        {wideEnoughForInspector && (
          <aside className="w-90 shrink-0 overflow-y-auto border-l" aria-label="Node inspector">
            <NodeInspector node={selectedNode} specs={nodeKinds.data ?? []} />
          </aside>
        )}
      </div>

      {/* Below ~1024px the panels become sheets. Selecting a node opens the
          inspector, so a tap on the canvas still leads somewhere. */}
      {!wideEnoughForInspector && (
        <Sheet open={selectedNode !== null} onOpenChange={(open) => !open && select(null)}>
          <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
            <SheetHeader className="sr-only">
              <SheetTitle>Node inspector</SheetTitle>
              <SheetDescription>Edit the selected node’s label and configuration.</SheetDescription>
            </SheetHeader>
            <NodeInspector node={selectedNode} specs={nodeKinds.data ?? []} />
          </SheetContent>
        </Sheet>
      )}

      {!wideEnoughForRail && (
        <Sheet open={railOpen} onOpenChange={setRailOpen}>
          <SheetContent side="left" className="w-full sm:max-w-xs">
            <SheetHeader>
              <SheetTitle>Workflow settings</SheetTitle>
              <SheetDescription>Model, persona, and the nodes you can add.</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{rail}</div>
          </SheetContent>
        </Sheet>
      )}

      <AlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => !open && setPendingNavigation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave with unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This workflow has edits that have not been saved. Leaving now discards them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const path = pendingNavigation
                setPendingNavigation(null)
                if (path) void navigate(path)
              }}
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
