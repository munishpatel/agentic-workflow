import { beforeEach, describe, expect, it } from 'vitest'
import type { NodeKindSpec, Workflow } from '@/types/api'
import { NODE_KINDS, SEED_WORKFLOWS } from '@/mocks/fixtures'
import { useEditorStore } from './editorStore'

const research = SEED_WORKFLOWS.find((workflow) => workflow.id === 'wf_research') as Workflow
const agentSpec = NODE_KINDS.find((spec) => spec.kind === 'agent') as NodeKindSpec

const store = () => useEditorStore.getState()

beforeEach(() => {
  store().reset()
  store().hydrate(research)
})

describe('hydrate', () => {
  it('copies the workflow in as a clean draft', () => {
    const state = store()
    expect(state.workflowId).toBe('wf_research')
    expect(state.meta.name).toBe('Research assistant')
    expect(state.nodes).toHaveLength(5)
    expect(state.isDirty).toBe(false)
    expect(state.past).toEqual([])
  })

  it('deep-copies, so edits cannot reach back into the query cache', () => {
    store().updateNodeLabel('n_route', 'Renamed')
    expect(research.nodes.find((node) => node.id === 'n_route')?.label).toBe('Triage')
  })
})

describe('mutations mark the draft dirty', () => {
  it('sets isDirty and records history for each edit', () => {
    expect(store().isDirty).toBe(false)
    store().setMeta('name', 'Renamed')
    expect(store().isDirty).toBe(true)
    expect(store().past).toHaveLength(1)
  })

  it('drops a stale validation result when the graph changes', () => {
    useEditorStore.setState({ validation: { valid: true, errors: [], warnings: [] } })
    store().updateNodeLabel('n_route', 'Triage 2')
    expect(store().validation).toBeNull()
  })

  it('caps undo history at 50 entries', () => {
    for (let index = 0; index < 60; index += 1) store().setMeta('name', `Name ${index}`)
    expect(store().past).toHaveLength(50)
  })
})

describe('removeNode', () => {
  it('drops every edge touching the node — incoming and outgoing', () => {
    store().removeNode('n_route')
    const state = store()
    expect(state.nodes.some((node) => node.id === 'n_route')).toBe(false)
    expect(
      state.edges.some(
        (edge) => edge.source.node_id === 'n_route' || edge.target.node_id === 'n_route',
      ),
    ).toBe(false)
    // The router had one incoming and two outgoing edges; two unrelated remain.
    expect(state.edges).toHaveLength(2)
  })

  it('clears the selection when the selected node goes', () => {
    store().select('n_route')
    store().removeNode('n_route')
    expect(store().selectedNodeId).toBeNull()
  })

  it('leaves a different selection alone', () => {
    store().select('n_out')
    store().removeNode('n_route')
    expect(store().selectedNodeId).toBe('n_out')
  })
})

describe('connect', () => {
  it('adds an edge for a valid connection', () => {
    store().removeEdge('e_direct_out')
    const before = store().edges.length
    const verdict = store().connect(
      { node_id: 'n_direct', port: 'text' },
      { node_id: 'n_out', port: 'response' },
      NODE_KINDS,
    )
    expect(verdict.ok).toBe(true)
    expect(store().edges).toHaveLength(before + 1)
  })

  it('rejects an incompatible type without touching the graph', () => {
    const before = store().edges.length
    const verdict = store().connect(
      { node_id: 'n_in', port: 'history' }, // json
      { node_id: 'n_route', port: 'input' }, // text
      NODE_KINDS,
    )
    expect(verdict).toMatchObject({ ok: false })
    expect(store().edges).toHaveLength(before)
    expect(store().isDirty).toBe(false)
  })

  it('rejects a cycle', () => {
    // Free the port first, so the cycle rule is what rejects this and not the
    // single-assignment rule that would otherwise fire earlier.
    store().removeEdge('e_in_route')
    const verdict = store().connect(
      { node_id: 'n_research', port: 'text' },
      { node_id: 'n_route', port: 'input' },
      NODE_KINDS,
    )
    expect(verdict).toMatchObject({ ok: false, reason: 'That would create a cycle.' })
  })

  it('allows two router branches to converge on one input', () => {
    // The seeded graph already does this: both agents feed out.response.
    const incoming = store().edges.filter((edge) => edge.target.node_id === 'n_out')
    expect(incoming).toHaveLength(2)
  })
})

describe('addNode', () => {
  it('seeds config from the schema defaults and selects the new node', () => {
    const id = store().addNode(agentSpec, { x: 10, y: 20 })
    const node = store().nodes.find((entry) => entry.id === id)
    expect(node).toMatchObject({ kind: 'agent', position: { x: 10, y: 20 } })
    expect(node?.config).toMatchObject({ tools: [], max_tool_iterations: 5 })
    expect(store().selectedNodeId).toBe(id)
  })
})

describe('undo and redo', () => {
  it('restores the previous graph and then re-applies it', () => {
    store().removeNode('n_direct')
    expect(store().nodes).toHaveLength(4)

    store().undo()
    expect(store().nodes).toHaveLength(5)
    expect(store().edges.some((edge) => edge.source.node_id === 'n_direct')).toBe(true)

    store().redo()
    expect(store().nodes).toHaveLength(4)
  })

  it('does nothing when there is no history', () => {
    const before = store().nodes
    store().undo()
    expect(store().nodes).toBe(before)
  })

  it('clears the redo stack once a new edit lands', () => {
    store().updateNodeLabel('n_out', 'A')
    store().undo()
    expect(store().future).toHaveLength(1)
    store().updateNodeLabel('n_out', 'B')
    expect(store().future).toEqual([])
  })

  it('drops a selection that undo removed', () => {
    const id = store().addNode(agentSpec, { x: 0, y: 0 })
    expect(store().selectedNodeId).toBe(id)
    store().undo()
    expect(store().selectedNodeId).toBeNull()
  })
})

describe('toInput', () => {
  it('produces a body the API accepts, trimming and nulling empties', () => {
    store().setMeta('name', '  Spaced  ')
    store().setMeta('description', '   ')
    const input = store().toInput()
    expect(input.name).toBe('Spaced')
    expect(input.description).toBeNull()
    expect(input).not.toHaveProperty('id')
    expect(input).not.toHaveProperty('updated_at')
    expect(input.nodes).toHaveLength(5)
  })
})

describe('markSaved', () => {
  it('clears the dirty flag without discarding the draft', () => {
    store().updateNodeLabel('n_out', 'Final reply')
    store().markSaved({ ...research, id: 'wf_research' })
    expect(store().isDirty).toBe(false)
    expect(store().nodes.find((node) => node.id === 'n_out')?.label).toBe('Final reply')
  })
})
