import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import type { RunResponse, ValidationResult, Workflow, WorkflowSummary } from '@/types/api'
import { handlers } from './handlers'
import { mockDb } from './db'

/**
 * The mock API is the app's only backend until phase 6, so it gets the same
 * treatment as production code: exercised end to end, including its failure
 * fixtures. These tests double as executable documentation of the contract.
 */
const server = setupServer(...handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  mockDb.reset()
})
afterAll(() => server.close())

const BASE = 'http://localhost/api'

describe('schema discovery', () => {
  it('publishes node kinds, tools and providers', async () => {
    const kinds = await (await fetch(`${BASE}/node-kinds`)).json()
    expect(kinds.map((k: { kind: string }) => k.kind)).toEqual([
      'input',
      'agent',
      'tool',
      'router',
      'output',
    ])

    const tools = await (await fetch(`${BASE}/tools`)).json()
    expect(tools).toHaveLength(4)

    const providers = await (await fetch(`${BASE}/providers`)).json()
    expect(providers[0].models).toContain('claude-opus-5')
  })
})

describe('workflow CRUD', () => {
  it('lists seeded workflows as summaries with their tool ids', async () => {
    const list: WorkflowSummary[] = await (await fetch(`${BASE}/workflows`)).json()
    expect(list).toHaveLength(2)
    const research = list.find((w) => w.id === 'wf_research')
    expect(research?.node_count).toBe(5)
    expect(research?.tool_ids).toContain('web_search')
  })

  it('creates, reads, updates and deletes', async () => {
    const created: Workflow = await (
      await fetch(`${BASE}/workflows`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Fresh',
          description: null,
          provider: 'anthropic',
          model: 'claude-opus-5',
          system_prompt: '',
          nodes: [],
          edges: [],
        }),
      })
    ).json()
    expect(created.id).toMatch(/^wf_/)

    const fetched: Workflow = await (await fetch(`${BASE}/workflows/${created.id}`)).json()
    expect(fetched.name).toBe('Fresh')

    const updated: Workflow = await (
      await fetch(`${BASE}/workflows/${created.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...fetched, name: 'Renamed' }),
      })
    ).json()
    expect(updated.name).toBe('Renamed')
    expect(updated.created_at).toBe(created.created_at)

    const deleted = await fetch(`${BASE}/workflows/${created.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect((await fetch(`${BASE}/workflows/${created.id}`)).status).toBe(404)
  })

  it('returns the documented error envelope on a missing workflow', async () => {
    const response = await fetch(`${BASE}/workflows/nope`)
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('not_found')
    expect(typeof body.error.message).toBe('string')
  })
})

describe('validation', () => {
  it('accepts the seeded graph', async () => {
    const workflow: Workflow = await (await fetch(`${BASE}/workflows/wf_research`)).json()
    const result: ValidationResult = await (
      await fetch(`${BASE}/workflows/wf_research/validate`, {
        method: 'POST',
        body: JSON.stringify(workflow),
      })
    ).json()
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('reports a graph with no output node', async () => {
    const workflow: Workflow = await (await fetch(`${BASE}/workflows/wf_math`)).json()
    const broken = {
      ...workflow,
      nodes: workflow.nodes.filter((n) => n.kind !== 'output'),
      edges: workflow.edges.filter((e) => e.target.node_id !== 'm_out'),
    }
    const result: ValidationResult = await (
      await fetch(`${BASE}/workflows/wf_math/validate`, {
        method: 'POST',
        body: JSON.stringify(broken),
      })
    ).json()
    expect(result.valid).toBe(false)
    expect(result.errors.map((e) => e.code)).toContain('missing_output_node')
  })
})

describe('runs', () => {
  it('returns an ordered event log and stores the run for replay', async () => {
    const run: RunResponse = await (
      await fetch(`${BASE}/workflows/wf_research/run`, {
        method: 'POST',
        body: JSON.stringify({ message: 'What changed in agent tooling?', history: [] }),
      })
    ).json()

    const seqs = run.events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(run.events[0]?.type).toBe('run.start')
    expect(run.events.at(-1)?.type).toBe('run.end')
    expect(run.events.some((e) => e.type === 'route.decision')).toBe(true)
    expect(run.events.some((e) => e.type === 'node.skipped')).toBe(true)
    expect(run.events.some((e) => e.type === 'edge.transfer')).toBe(true)
    expect(run.final_response).not.toBe('')

    const replayed: RunResponse = await (await fetch(`${BASE}/runs/${run.run_id}`)).json()
    expect(replayed.events).toEqual(run.events)

    const history = await (await fetch(`${BASE}/workflows/wf_research/runs`)).json()
    expect(history).toHaveLength(1)
  })

  it('emits a failing tool result the agent recovers from', async () => {
    const run: RunResponse = await (
      await fetch(`${BASE}/workflows/wf_math/run`, {
        method: 'POST',
        body: JSON.stringify({ message: 'make this fail please', history: [] }),
      })
    ).json()
    const failed = run.events.find((e) => e.type === 'tool.result' && e.payload.is_error)
    expect(failed).toBeDefined()
    expect(run.final_response).not.toBe('')
  })

  it('ends in run.error when the model refuses', async () => {
    const run: RunResponse = await (
      await fetch(`${BASE}/workflows/wf_research/run`, {
        method: 'POST',
        body: JSON.stringify({ message: 'please refuse this', history: [] }),
      })
    ).json()
    expect(run.events.at(-1)?.type).toBe('run.error')
    expect(run.final_response).toBe('')
  })

  it('surfaces transport failures through the error envelope', async () => {
    const boom = await fetch(`${BASE}/workflows/wf_math/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'boom', history: [] }),
    })
    expect(boom.status).toBe(500)

    const noKey = await fetch(`${BASE}/workflows/wf_math/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'nokey', history: [] }),
    })
    expect((await noKey.json()).error.code).toBe('missing_api_key')
  })
})
