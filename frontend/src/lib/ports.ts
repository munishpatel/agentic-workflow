import type { Edge, EdgeEnd, NodeKindSpec, PortSpec, PortType, WorkflowNode } from '@/types/api'

/**
 * Graph rules. All of them live here rather than in components so they can be
 * unit-tested and so the canvas, the mock backend and the inspector agree.
 *
 * The server's `POST /validate` is the authority on graph correctness. What is
 * here exists to make a bad connection un-draggable — a UX affordance, not a
 * second source of truth. If the two ever disagree, the server wins.
 */

/* ── Port resolution ─────────────────────────────────────────────────────── */

interface RouteConfig {
  label: string
  description: string
}

function readRoutes(node: WorkflowNode): RouteConfig[] {
  const routes = node.config['routes']
  if (!Array.isArray(routes)) return []
  return routes.flatMap((route) => {
    if (typeof route !== 'object' || route === null) return []
    const { label, description } = route as { label?: unknown; description?: unknown }
    if (typeof label !== 'string' || label.length === 0) return []
    return [{ label, description: typeof description === 'string' ? description : '' }]
  })
}

/**
 * Static output specs come straight from the kind. Only `router` is "dynamic":
 * its ports are one `text` port per configured route, named after the label.
 */
export function resolveOutputs(spec: NodeKindSpec, node: WorkflowNode): PortSpec[] {
  if (spec.outputs !== 'dynamic') return spec.outputs
  if (node.kind !== 'router') return []
  return readRoutes(node).map((route) => ({
    name: route.label,
    type: 'text' as const,
    required: false,
    description: route.description,
  }))
}

/** Inputs are static in v1 — `tool` nodes take literal args, not wired ones. */
export function resolveInputs(spec: NodeKindSpec, _node: WorkflowNode): PortSpec[] {
  return spec.inputs
}

export function findSpec(specs: NodeKindSpec[], kind: string): NodeKindSpec | undefined {
  return specs.find((spec) => spec.kind === kind)
}

export interface ResolvedPorts {
  inputs: PortSpec[]
  outputs: PortSpec[]
}

export function resolvePorts(specs: NodeKindSpec[], node: WorkflowNode): ResolvedPorts {
  const spec = findSpec(specs, node.kind)
  if (!spec) return { inputs: [], outputs: [] }
  return { inputs: resolveInputs(spec, node), outputs: resolveOutputs(spec, node) }
}

/* ── Type compatibility ──────────────────────────────────────────────────── */

/**
 * Mirrors the backend rule: `any` connects to anything, identical types
 * connect, and everything else — notably `text ↔ json` — is rejected.
 */
export function arePortsCompatible(source: PortType, target: PortType): boolean {
  if (source === 'any' || target === 'any') return true
  return source === target
}

/* ── Reachability ────────────────────────────────────────────────────────── */

/** Is there a directed path from `from` to `to` following edges? */
export function hasPath(edges: Edge[], from: string, to: string): boolean {
  if (from === to) return true
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.source.node_id)
    if (list) list.push(edge.target.node_id)
    else adjacency.set(edge.source.node_id, [edge.target.node_id])
  }
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    for (const next of adjacency.get(current) ?? []) {
      if (next === to) return true
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return false
}

/**
 * The set of router gates a node sits behind, as `${routerId}:${port}`.
 *
 * A router activates exactly one of its output ports, so two nodes behind
 * different ports of the same router can never run in the same pass. That is
 * what makes the seeded `input → router → {A | B} → output` graph legal even
 * though input ports are otherwise single-assignment.
 */
export function routerGates(
  nodes: WorkflowNode[],
  edges: Edge[],
  nodeId: string,
  gates = new Set<string>(),
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(nodeId)) return gates
  seen.add(nodeId)
  const kindById = new Map(nodes.map((node) => [node.id, node.kind]))
  for (const edge of edges) {
    if (edge.target.node_id !== nodeId) continue
    if (kindById.get(edge.source.node_id) === 'router') {
      gates.add(`${edge.source.node_id}:${edge.source.port}`)
    }
    routerGates(nodes, edges, edge.source.node_id, gates, seen)
  }
  return gates
}

/** True when no single run can activate both nodes. */
export function areMutuallyExclusive(
  nodes: WorkflowNode[],
  edges: Edge[],
  a: string,
  b: string,
): boolean {
  const gatesA = routerGates(nodes, edges, a)
  const gatesB = routerGates(nodes, edges, b)
  for (const gate of gatesA) {
    const [routerId, port] = gate.split(':')
    for (const other of gatesB) {
      const [otherRouter, otherPort] = other.split(':')
      if (routerId === otherRouter && port !== otherPort) return true
    }
  }
  return false
}

/* ── Connection rules ────────────────────────────────────────────────────── */

export type ConnectVerdict = { ok: true } | { ok: false; reason: string }

export interface GraphContext {
  nodes: WorkflowNode[]
  edges: Edge[]
  specs: NodeKindSpec[]
}

function portOf(ports: PortSpec[], name: string): PortSpec | undefined {
  return ports.find((port) => port.name === name)
}

/**
 * Everything that makes a connection illegal, in the order a user would hit it.
 * The reason strings are shown verbatim in the UI, so they name the fix.
 */
export function canConnect(ctx: GraphContext, source: EdgeEnd, target: EdgeEnd): ConnectVerdict {
  const sourceNode = ctx.nodes.find((node) => node.id === source.node_id)
  const targetNode = ctx.nodes.find((node) => node.id === target.node_id)
  if (!sourceNode || !targetNode) return { ok: false, reason: 'That node no longer exists.' }
  if (sourceNode.id === targetNode.id) {
    return { ok: false, reason: 'A node cannot connect to itself.' }
  }

  const sourcePort = portOf(resolvePorts(ctx.specs, sourceNode).outputs, source.port)
  const targetPort = portOf(resolvePorts(ctx.specs, targetNode).inputs, target.port)
  if (!sourcePort) return { ok: false, reason: `${sourceNode.label} has no output “${source.port}”.` }
  if (!targetPort) return { ok: false, reason: `${targetNode.label} has no input “${target.port}”.` }

  if (!arePortsCompatible(sourcePort.type, targetPort.type)) {
    return {
      ok: false,
      reason: `${sourcePort.type} cannot feed a ${targetPort.type} input. Convert the value first.`,
    }
  }

  const duplicate = ctx.edges.some(
    (edge) =>
      edge.source.node_id === source.node_id &&
      edge.source.port === source.port &&
      edge.target.node_id === target.node_id &&
      edge.target.port === target.port,
  )
  if (duplicate) return { ok: false, reason: 'These ports are already connected.' }

  const occupants = ctx.edges.filter(
    (edge) => edge.target.node_id === target.node_id && edge.target.port === target.port,
  )
  const conflicting = occupants.find(
    (edge) => !areMutuallyExclusive(ctx.nodes, ctx.edges, edge.source.node_id, source.node_id),
  )
  if (conflicting) {
    return {
      ok: false,
      reason: `“${targetPort.name}” already receives data. Remove that connection first, or feed it from a different router branch.`,
    }
  }

  if (hasPath(ctx.edges, target.node_id, source.node_id)) {
    return { ok: false, reason: 'That would create a cycle.' }
  }

  return { ok: true }
}
