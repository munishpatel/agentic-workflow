import { useMemo, useState } from 'react'
import { ArrowRight, Link2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import type { EdgeEnd, NodeKindSpec } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { nodeKindVisual, portTypeDot } from '@/lib/nodeVisuals'
import { summariseNodeConfig } from '@/lib/nodeSummary'
import { resolvePorts } from '@/lib/ports'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/store/editorStore'

/**
 * A text view of the same graph the canvas draws.
 *
 * It exists because dragging on a canvas is not usable with a keyboard or a
 * screen reader, and because connections are easier to verify as a list than as
 * a picture. Both views read and write the same store.
 */
export function GraphOutline({ specs }: { specs: NodeKindSpec[] }) {
  const nodes = useEditorStore((state) => state.nodes)
  const edges = useEditorStore((state) => state.edges)
  const selectedNodeId = useEditorStore((state) => state.selectedNodeId)
  const select = useEditorStore((state) => state.select)
  const connect = useEditorStore((state) => state.connect)
  const removeEdge = useEditorStore((state) => state.removeEdge)

  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')

  const labelOf = useMemo(() => {
    const map: Record<string, string> = {}
    for (const node of nodes) map[node.id] = node.label
    return map
  }, [nodes])

  const sourceOptions = nodes.flatMap((node) =>
    resolvePorts(specs, node).outputs.map((port) => ({
      value: `${node.id}::${port.name}`,
      label: `${node.label}.${port.name}`,
      type: port.type,
    })),
  )

  const targetOptions = nodes.flatMap((node) =>
    resolvePorts(specs, node).inputs.map((port) => ({
      value: `${node.id}::${port.name}`,
      label: `${node.label}.${port.name}`,
      type: port.type,
    })),
  )

  function parseEnd(value: string): EdgeEnd | null {
    const [nodeId, port] = value.split('::')
    if (!nodeId || !port) return null
    return { node_id: nodeId, port }
  }

  function handleConnect() {
    const from = parseEnd(source)
    const to = parseEnd(target)
    if (!from || !to) return
    const verdict = connect(from, to, specs)
    if (verdict.ok) {
      setSource('')
      setTarget('')
      toast.success('Connected')
    } else {
      toast.error('Cannot connect', { description: verdict.reason })
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <section>
        <h2 className="mb-2 text-sm font-medium">Nodes</h2>
        <ul className="space-y-1.5">
          {nodes.map((node) => {
            const visual = nodeKindVisual(node.kind)
            const Icon = visual.icon
            const summary = summariseNodeConfig(node)
            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => select(node.id)}
                  aria-current={node.id === selectedNodeId}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg border-l-4 border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/60',
                    'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                    visual.border,
                    node.id === selectedNodeId && 'ring-2 ring-ring/40',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md',
                      visual.bg,
                      visual.text,
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{node.label}</span>
                    {summary && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {summary}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{node.kind}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Connections</h2>
        {edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is connected yet. Data only moves along a connection.
          </p>
        ) : (
          <ul className="space-y-1">
            {edges.map((edge) => {
              const sourceNode = nodes.find((node) => node.id === edge.source.node_id)
              const type = sourceNode
                ? resolvePorts(specs, sourceNode).outputs.find(
                    (port) => port.name === edge.source.port,
                  )?.type
                : undefined
              return (
                <li
                  key={edge.id}
                  className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm"
                >
                  <span className="font-medium">{labelOf[edge.source.node_id] ?? '?'}</span>
                  <code className="font-mono text-xs text-muted-foreground">
                    {edge.source.port}
                  </code>
                  <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                  {type && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span
                        className={cn('size-1.5 rounded-full', portTypeDot(type))}
                        aria-hidden
                      />
                      {type}
                    </span>
                  )}
                  <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="font-medium">{labelOf[edge.target.node_id] ?? '?'}</span>
                  <code className="font-mono text-xs text-muted-foreground">
                    {edge.target.port}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    aria-label="Remove connection"
                    onClick={() => removeEdge(edge.id)}
                  >
                    <Unlink aria-hidden />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border bg-muted/30 p-3">
        <h2 className="mb-2 text-sm font-medium">Connect two ports</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-52 flex-1 gap-1.5">
            <Label htmlFor="connect-source">From</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="connect-source" className="w-full">
                <SelectValue placeholder="Output port…" />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label} · {option.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid min-w-52 flex-1 gap-1.5">
            <Label htmlFor="connect-target">To</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="connect-target" className="w-full">
                <SelectValue placeholder="Input port…" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label} · {option.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleConnect} disabled={!source || !target}>
            <Link2 aria-hidden />
            Connect
          </Button>
        </div>
      </section>
    </div>
  )
}
