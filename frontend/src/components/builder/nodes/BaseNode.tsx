import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { PortSpec, WorkflowNode } from '@/types/api'
import { nodeKindVisual, portTypeColour } from '@/lib/nodeVisuals'
import { summariseNodeConfig } from '@/lib/nodeSummary'
import { cn } from '@/lib/utils'

/**
 * One component renders every node kind.
 *
 * The plan sketches a file per kind sharing a shell, but they would be the same
 * file five times — and, more importantly, a kind added on the backend would
 * have no component at all. Rendering from the published spec keeps the promise
 * that a new node kind needs no frontend change; a kind that later earns
 * bespoke treatment can still be given its own entry in `NODE_TYPES`.
 */

export interface GraphNodeData extends Record<string, unknown> {
  node: WorkflowNode
  inputs: PortSpec[]
  outputs: PortSpec[]
  isSelected: boolean
  hasError: boolean
}

export type GraphFlowNode = Node<GraphNodeData, 'graphNode'>

/**
 * Geometry in pixels rather than percentages: a handle has to line up with its
 * own label, and a percentage of the whole node puts a single port halfway down
 * the card — on top of the header.
 */
const HEADER_HEIGHT = 30
const SUMMARY_HEIGHT = 16
const ROW_HEIGHT = 20
const PORTS_PADDING = 8

function rowTop(index: number, headerHeight: number): number {
  return headerHeight + PORTS_PADDING + index * ROW_HEIGHT + ROW_HEIGHT / 2
}

function PortRow({ port, side, top }: { port: PortSpec; side: 'input' | 'output'; top: number }) {
  const isInput = side === 'input'
  return (
    <>
      <Handle
        type={isInput ? 'target' : 'source'}
        // The handle id *is* the port name — this is what makes an edge
        // port-to-port rather than node-to-node.
        id={port.name}
        position={isInput ? Position.Left : Position.Right}
        style={{ top }}
        className={cn(
          '!size-2.5 !border-2 !border-background',
          port.type === 'text' && '!bg-port-text',
          port.type === 'json' && '!bg-port-json',
          port.type === 'number' && '!bg-port-number',
          port.type === 'boolean' && '!bg-port-boolean',
          port.type === 'any' && '!bg-port-any',
        )}
        title={`${port.name} · ${port.type}${port.required ? ' · required' : ''}`}
      />
      <span
        className={cn(
          'pointer-events-none absolute flex -translate-y-1/2 items-baseline gap-1 text-[0.65rem] leading-none whitespace-nowrap',
          isInput ? 'left-2.5' : 'right-2.5 flex-row-reverse',
        )}
        style={{ top }}
      >
        <span className="font-mono text-foreground/80">{port.name}</span>
        <span className={portTypeColour(port.type)}>{port.type}</span>
      </span>
    </>
  )
}

function BaseNodeComponent({ data }: NodeProps<GraphFlowNode>) {
  const { node, inputs, outputs, isSelected, hasError } = data
  const visual = nodeKindVisual(node.kind)
  const Icon = visual.icon
  const summary = summariseNodeConfig(node)

  const headerHeight = HEADER_HEIGHT + (summary ? SUMMARY_HEIGHT : 0)
  const rows = Math.max(inputs.length, outputs.length)
  const height = headerHeight + rows * ROW_HEIGHT + PORTS_PADDING * 2

  return (
    <div
      className={cn(
        'relative w-56 rounded-xl border border-l-4 bg-card shadow-sm',
        visual.border,
        isSelected && 'ring-2 ring-ring/60',
        hasError && 'ring-2 ring-destructive/70',
      )}
      style={{ height }}
    >
      <div className="flex h-[30px] items-center gap-1.5 px-2.5">
        <span
          className={cn(
            'flex size-4.5 shrink-0 items-center justify-center rounded',
            visual.bg,
            visual.text,
          )}
        >
          <Icon className="size-2.5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8rem] font-medium">{node.label}</span>
        <span className="text-[0.6rem] text-muted-foreground">{node.kind}</span>
      </div>

      {summary && (
        <p className="truncate px-2.5 text-[0.65rem] leading-4 text-muted-foreground">{summary}</p>
      )}

      {inputs.map((port, index) => (
        <PortRow key={port.name} port={port} side="input" top={rowTop(index, headerHeight)} />
      ))}
      {outputs.map((port, index) => (
        <PortRow key={port.name} port={port} side="output" top={rowTop(index, headerHeight)} />
      ))}
    </div>
  )
}

export const BaseNode = memo(BaseNodeComponent)
