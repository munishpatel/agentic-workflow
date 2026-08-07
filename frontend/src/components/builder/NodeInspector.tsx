import { MousePointerSquareDashed, Trash2 } from 'lucide-react'
import type { NodeKindSpec, PortSpec, WorkflowNode } from '@/types/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { NodeConfigForm } from '@/components/builder/NodeConfigForm'
import { EmptyState } from '@/components/common/EmptyState'
import { useDebouncedCommit } from '@/hooks/useDebouncedCommit'
import { nodeKindVisual, portTypeDot } from '@/lib/nodeVisuals'
import { findSpec, resolvePorts } from '@/lib/ports'
import { useTools } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/store/editorStore'

interface NodeInspectorProps {
  node: WorkflowNode | null
  specs: NodeKindSpec[]
}

function PortList({
  title,
  ports,
  connectedPorts,
  emptyLabel,
}: {
  title: string
  ports: PortSpec[]
  connectedPorts: Set<string>
  emptyLabel: string
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
      {ports.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {ports.map((port) => (
            <li key={port.name} className="flex items-baseline gap-1.5 text-sm">
              <span
                className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', portTypeDot(port.type))}
                aria-hidden
              />
              <span className="font-mono text-xs">{port.name}</span>
              <span className="text-xs text-muted-foreground">{port.type}</span>
              {port.required && !connectedPorts.has(port.name) && (
                <span className="text-xs text-destructive">not connected</span>
              )}
              {connectedPorts.has(port.name) && (
                <span className="text-xs text-muted-foreground">· wired</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function NodeInspector({ node, specs }: NodeInspectorProps) {
  const edges = useEditorStore((state) => state.edges)
  const updateNodeLabel = useEditorStore((state) => state.updateNodeLabel)
  const updateNodeConfig = useEditorStore((state) => state.updateNodeConfig)
  const removeNode = useEditorStore((state) => state.removeNode)
  const tools = useTools()

  const [label, setLabel] = useDebouncedCommit(node?.label ?? '', (next) => {
    if (node) updateNodeLabel(node.id, next)
  })

  if (!node) {
    return (
      <EmptyState
        icon={MousePointerSquareDashed}
        title="Nothing selected"
        description="Pick a node to edit its label, its configuration and see the ports it exposes."
        className="border-0"
      />
    )
  }

  const spec = findSpec(specs, node.kind)
  if (!spec) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This node’s kind (<code className="font-mono">{node.kind}</code>) is not published by the
        backend, so it cannot be edited here.
      </div>
    )
  }

  const { inputs, outputs } = resolvePorts(specs, node)
  const wiredInputs = new Set(
    edges.filter((edge) => edge.target.node_id === node.id).map((edge) => edge.target.port),
  )
  const wiredOutputs = new Set(
    edges.filter((edge) => edge.source.node_id === node.id).map((edge) => edge.source.port),
  )

  const visual = nodeKindVisual(node.kind)
  const Icon = visual.icon

  // `tool` nodes take literal arguments in v1, rendered from the selected
  // tool's own input schema by the same renderer (frontend-plan.md §6.4).
  const selectedToolId = typeof node.config['tool_id'] === 'string' ? node.config['tool_id'] : null
  const selectedTool = tools.data?.find((tool) => tool.id === selectedToolId)

  const nodeId = node.id

  /** Read the config fresh, so two editors on one node cannot clobber each other. */
  function writeConfig(patch: Record<string, unknown>) {
    const current = useEditorStore.getState().nodes.find((entry) => entry.id === nodeId)
    if (!current) return
    updateNodeConfig(nodeId, { ...current.config, ...patch })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md',
            visual.bg,
            visual.text,
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{node.label}</p>
          <p className="text-xs text-muted-foreground">{spec.label}</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${node.label}`}
          onClick={() => removeNode(node.id)}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="node-label">Label</Label>
          <Input id="node-label" value={label} onChange={(event) => setLabel(event.target.value)} />
        </div>

        <Separator />

        <NodeConfigForm
          key={node.id}
          schema={spec.config_schema}
          value={node.config}
          onChange={writeConfig}
          idPrefix={`node-${node.id}`}
          omit={node.kind === 'tool' ? ['args'] : []}
          emptyHint="This node kind has no settings — its behaviour comes from how it is wired."
        />

        {node.kind === 'tool' && selectedTool && (
          <>
            <Separator />
            <div>
              <p className="text-sm font-medium">Arguments</p>
              <p className="mb-3 text-xs text-muted-foreground">
                Literal values for {selectedTool.name}. Wiring arguments to input ports is a
                follow-up — see the README.
              </p>
              <NodeConfigForm
                key={`${node.id}-${selectedTool.id}`}
                schema={selectedTool.input_schema}
                value={
                  typeof node.config['args'] === 'object' && node.config['args'] !== null
                    ? (node.config['args'] as Record<string, unknown>)
                    : {}
                }
                onChange={(args) => writeConfig({ args })}
                idPrefix={`args-${node.id}`}
              />
            </div>
          </>
        )}

        <Separator />

        <div className="space-y-3">
          <PortList
            title="Inputs"
            ports={inputs}
            connectedPorts={wiredInputs}
            emptyLabel="No inputs — this node starts the graph."
          />
          <PortList
            title="Outputs"
            ports={outputs}
            connectedPorts={wiredOutputs}
            emptyLabel={
              node.kind === 'router'
                ? 'Add routes above — each one becomes an output port.'
                : 'No outputs — this node ends the graph.'
            }
          />
          {node.kind === 'router' && outputs.length > 0 && (
            <Badge variant="secondary" className="font-normal">
              Ports follow the routes
            </Badge>
          )}
        </div>
      </div>
    </div>
  )
}
