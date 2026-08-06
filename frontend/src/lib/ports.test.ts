import { describe, expect, it } from 'vitest'
import type { Edge, WorkflowNode } from '@/types/api'
import { NODE_KINDS } from '@/mocks/fixtures'
import {
  arePortsCompatible,
  areMutuallyExclusive,
  canConnect,
  hasPath,
  resolveOutputs,
  resolvePorts,
} from './ports'

const node = (id: string, kind: WorkflowNode['kind'], config: WorkflowNode['config'] = {}) =>
  ({ id, kind, label: id, config, position: { x: 0, y: 0 } }) satisfies WorkflowNode

const edge = (id: string, from: string, fromPort: string, to: string, toPort: string) =>
  ({
    id,
    source: { node_id: from, port: fromPort },
    target: { node_id: to, port: toPort },
  }) satisfies Edge

const router = node('router', 'router', {
  routes: [
    { label: 'a', description: 'first' },
    { label: 'b', description: 'second' },
  ],
})

/** input → router → {agentA | agentB} → output — the seeded branching graph. */
const branching = {
  nodes: [
    node('in', 'input'),
    router,
    node('agentA', 'agent'),
    node('agentB', 'agent'),
    node('out', 'output'),
  ],
  edges: [
    edge('e1', 'in', 'message', 'router', 'input'),
    edge('e2', 'router', 'a', 'agentA', 'prompt'),
    edge('e3', 'router', 'b', 'agentB', 'prompt'),
    edge('e4', 'agentA', 'text', 'out', 'response'),
  ],
  specs: NODE_KINDS,
}

describe('arePortsCompatible', () => {
  it('connects identical types', () => {
    expect(arePortsCompatible('text', 'text')).toBe(true)
  })

  it('treats any as a wildcard in both directions', () => {
    expect(arePortsCompatible('any', 'json')).toBe(true)
    expect(arePortsCompatible('number', 'any')).toBe(true)
  })

  it('rejects text ↔ json', () => {
    expect(arePortsCompatible('text', 'json')).toBe(false)
    expect(arePortsCompatible('json', 'text')).toBe(false)
  })
})

describe('resolveOutputs', () => {
  it('returns the static spec for non-dynamic kinds', () => {
    const spec = NODE_KINDS.find((k) => k.kind === 'agent')!
    expect(resolveOutputs(spec, node('a', 'agent')).map((p) => p.name)).toEqual(['text'])
  })

  it('derives one text port per route for a router', () => {
    const spec = NODE_KINDS.find((k) => k.kind === 'router')!
    const ports = resolveOutputs(spec, router)
    expect(ports.map((p) => p.name)).toEqual(['a', 'b'])
    expect(ports.every((p) => p.type === 'text')).toBe(true)
  })

  it('ignores malformed route entries rather than throwing', () => {
    const spec = NODE_KINDS.find((k) => k.kind === 'router')!
    const broken = node('r', 'router', { routes: [{ label: 'ok' }, null, { nope: 1 }, 'x'] })
    expect(resolveOutputs(spec, broken).map((p) => p.name)).toEqual(['ok'])
  })

  it('resolves an input node to zero inputs', () => {
    expect(resolvePorts(NODE_KINDS, node('in', 'input')).inputs).toEqual([])
  })
})

describe('hasPath', () => {
  const edges = [edge('e1', 'a', 'out', 'b', 'in'), edge('e2', 'b', 'out', 'c', 'in')]

  it('follows edges transitively', () => {
    expect(hasPath(edges, 'a', 'c')).toBe(true)
  })

  it('does not walk backwards', () => {
    expect(hasPath(edges, 'c', 'a')).toBe(false)
  })

  it('terminates on a cycle', () => {
    const cyclic = [...edges, edge('e3', 'c', 'out', 'a', 'in')]
    expect(hasPath(cyclic, 'a', 'c')).toBe(true)
    expect(hasPath(cyclic, 'c', 'b')).toBe(true)
  })
})

describe('areMutuallyExclusive', () => {
  it('is true for nodes behind different ports of one router', () => {
    expect(areMutuallyExclusive(branching.nodes, branching.edges, 'agentA', 'agentB')).toBe(true)
  })

  it('is false for nodes on the same branch', () => {
    expect(areMutuallyExclusive(branching.nodes, branching.edges, 'in', 'agentA')).toBe(false)
  })
})

describe('canConnect', () => {
  it('accepts a compatible, unoccupied connection', () => {
    const verdict = canConnect(
      branching,
      { node_id: 'agentB', port: 'text' },
      { node_id: 'out', port: 'response' },
    )
    expect(verdict.ok).toBe(true)
  })

  it('rejects a type mismatch', () => {
    const ctx = {
      nodes: [node('in', 'input'), node('r', 'router', { routes: [] })],
      edges: [],
      specs: NODE_KINDS,
    }
    const verdict = canConnect(
      ctx,
      { node_id: 'in', port: 'history' }, // json
      { node_id: 'r', port: 'input' }, // text
    )
    expect(verdict).toMatchObject({ ok: false })
  })

  it('rejects a second edge into an already-fed input on the same branch', () => {
    const ctx = {
      nodes: [node('a1', 'agent'), node('a2', 'agent'), node('out', 'output')],
      edges: [edge('e1', 'a1', 'text', 'out', 'response')],
      specs: NODE_KINDS,
    }
    const verdict = canConnect(
      ctx,
      { node_id: 'a2', port: 'text' },
      { node_id: 'out', port: 'response' },
    )
    expect(verdict.ok).toBe(false)
  })

  it('rejects a duplicate of an existing edge', () => {
    const verdict = canConnect(
      branching,
      { node_id: 'agentA', port: 'text' },
      { node_id: 'out', port: 'response' },
    )
    expect(verdict.ok).toBe(false)
  })

  it('rejects a connection that would close a cycle', () => {
    const ctx = {
      nodes: [node('a', 'agent'), node('b', 'agent')],
      edges: [edge('e1', 'a', 'text', 'b', 'prompt')],
      specs: NODE_KINDS,
    }
    const verdict = canConnect(
      ctx,
      { node_id: 'b', port: 'text' },
      { node_id: 'a', port: 'prompt' },
    )
    expect(verdict).toMatchObject({ ok: false, reason: 'That would create a cycle.' })
  })

  it('rejects a self-connection', () => {
    const ctx = { nodes: [node('a', 'agent')], edges: [], specs: NODE_KINDS }
    const verdict = canConnect(
      ctx,
      { node_id: 'a', port: 'text' },
      { node_id: 'a', port: 'prompt' },
    )
    expect(verdict.ok).toBe(false)
  })

  it('rejects an unknown port', () => {
    const ctx = { nodes: [node('a', 'agent'), node('out', 'output')], edges: [], specs: NODE_KINDS }
    const verdict = canConnect(
      ctx,
      { node_id: 'a', port: 'nope' },
      { node_id: 'out', port: 'response' },
    )
    expect(verdict.ok).toBe(false)
  })
})
