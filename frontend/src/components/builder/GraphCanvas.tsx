import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type IsValidConnection,
  type NodeChange,
} from '@xyflow/react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { NodeKindSpec, PortType } from '@/types/api'
import { BaseNode, type GraphFlowNode } from '@/components/builder/nodes/BaseNode'
import { canConnect, resolvePorts } from '@/lib/ports'
import { nodeKindColorVar, portTypeColorVar } from '@/lib/nodeVisuals'
import { useEditorStore } from '@/store/editorStore'

/**
 * The graph canvas.
 *
 * React Flow is driven from the Zustand draft, never the other way round: the
 * store is the single truth and this component is a view of it. The one place
 * React Flow's own state leads is during a drag — positions are applied locally
 * for smoothness and committed to the store on drag *end*, so undo history
 * holds one entry per drag instead of one per pixel.
 */

// Must be module-level. An inline object is a new reference every render, which
// remounts every node and loses focus, selection and drag state.
const NODE_TYPES = { graphNode: BaseNode }

function GraphCanvasInner({ specs }: { specs: NodeKindSpec[] }) {
  const nodes = useEditorStore((state) => state.nodes)
  const edges = useEditorStore((state) => state.edges)
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId)
  const validation = useEditorStore((state) => state.validation)
  const select = useEditorStore((state) => state.select)
  const connect = useEditorStore((state) => state.connect)
  const moveNode = useEditorStore((state) => state.moveNode)
  const removeNode = useEditorStore((state) => state.removeNode)
  const removeEdge = useEditorStore((state) => state.removeEdge)
  const addNode = useEditorStore((state) => state.addNode)

  const { screenToFlowPosition } = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)

  const errorNodeIds = useMemo(
    () =>
      new Set(
        (validation?.errors ?? []).flatMap((issue) => (issue.node_id ? [issue.node_id] : [])),
      ),
    [validation],
  )

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<GraphFlowNode>([])
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<FlowEdge>([])

  // Project the draft into React Flow's shape. Selection lives in `data` rather
  // than React Flow's own `selected`, so one store owns what is selected.
  useEffect(() => {
    setFlowNodes(
      nodes.map((node) => {
        const ports = resolvePorts(specs, node)
        return {
          id: node.id,
          type: 'graphNode' as const,
          position: node.position,
          data: {
            node,
            inputs: ports.inputs,
            outputs: ports.outputs,
            isSelected: node.id === selectedNodeId,
            hasError: errorNodeIds.has(node.id),
          },
        }
      }),
    )
  }, [nodes, specs, selectedNodeId, errorNodeIds, setFlowNodes])

  useEffect(() => {
    setFlowEdges(
      edges.map((edge) => {
        const sourceNode = nodes.find((node) => node.id === edge.source.node_id)
        const type: PortType =
          (sourceNode &&
            resolvePorts(specs, sourceNode).outputs.find((port) => port.name === edge.source.port)
              ?.type) ??
          'any'
        const stroke = portTypeColorVar(type)
        return {
          id: edge.id,
          source: edge.source.node_id,
          sourceHandle: edge.source.port,
          target: edge.target.node_id,
          targetHandle: edge.target.port,
          style: { stroke, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
        }
      }),
    )
  }, [edges, nodes, specs, setFlowEdges])

  const handleNodesChange = useCallback(
    (changes: NodeChange<GraphFlowNode>[]) => {
      onNodesChange(changes)
      for (const change of changes) {
        if (change.type === 'remove') removeNode(change.id)
      }
    },
    [onNodesChange, removeNode],
  )

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      if (!connection.sourceHandle || !connection.targetHandle) return false
      const state = useEditorStore.getState()
      return canConnect(
        { nodes: state.nodes, edges: state.edges, specs },
        { node_id: connection.source, port: connection.sourceHandle },
        { node_id: connection.target, port: connection.targetHandle },
      ).ok
    },
    [specs],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.sourceHandle || !connection.targetHandle) return
      const verdict = connect(
        { node_id: connection.source, port: connection.sourceHandle },
        { node_id: connection.target, port: connection.targetHandle },
        specs,
      )
      // `isValidConnection` already blocks the drag, so this only fires for a
      // race — but a silent no-op would be worse than a message.
      if (!verdict.ok) toast.error('Cannot connect', { description: verdict.reason })
    },
    [connect, specs],
  )

  // Ports come from the published kinds. Drawing before they arrive would mount
  // nodes with no handles, and every edge would fail to find its endpoint.
  if (specs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading node kinds…
      </div>
    )
  }

  return (
    <div ref={wrapper} className="h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgesDelete={(deleted) => deleted.forEach((edge) => removeEdge(edge.id))}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, node) => select(node.id)}
        onNodeDragStop={(_, node) => moveNode(node.id, node.position)}
        onPaneClick={() => select(null)}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          event.preventDefault()
          const kind = event.dataTransfer.getData('application/x-node-kind')
          const spec = specs.find((entry) => entry.kind === kind)
          if (!spec) return
          addNode(spec, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        }}
        connectionRadius={28}
        proOptions={{ hideAttribution: false }}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.75}
        deleteKeyCode={['Backspace', 'Delete']}
        className="bg-muted/20"
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          className="!bg-card"
          nodeColor={(node) => nodeKindColorVar((node.data as GraphFlowNode['data']).node.kind)}
        />
      </ReactFlow>
    </div>
  )
}

/** `screenToFlowPosition` needs the provider, so the export wraps it. */
export function GraphCanvas({ specs }: { specs: NodeKindSpec[] }) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner specs={specs} />
    </ReactFlowProvider>
  )
}
