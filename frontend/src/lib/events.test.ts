import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@/types/events'
import type { MessageEntry, NodeStep, ToolEntry, TransferStep } from '@/types/ui'
import {
  buildMathRun,
  buildRefusalRun,
  buildResearchRun,
  buildToolErrorRun,
} from '@/mocks/fixtures'
import { reduceEvents, summariseTimeline } from './events'

const START = 1_770_000_000_000
const research = buildResearchRun('run_1', 'What changed in agent tooling?', START)
const math = buildMathRun('run_2', 'What is 1200 * 1.08 / 3?', START)

const nodes = (steps: { kind: string }[]) => steps.filter((s): s is NodeStep => s.kind === 'node')
const transfers = (steps: { kind: string }[]) =>
  steps.filter((s): s is TransferStep => s.kind === 'transfer')

describe('reduceEvents — a branching run', () => {
  const view = reduceEvents(research.events)

  it('carries the run identity and outcome', () => {
    expect(view.runId).toBe('run_1')
    expect(view.workflowName).toBe('Research assistant')
    expect(view.status).toBe('ok')
    expect(view.finalResponse).toBe(research.final_response)
    expect(view.durationMs).toBe(research.duration_ms)
    expect(view.usage).toEqual(research.usage)
    expect(view.error).toBeNull()
  })

  it('groups node.start/node.end into one step with its duration', () => {
    const group = nodes(view.steps).find((step) => step.nodeId === 'n_research')
    expect(group).toMatchObject({ label: 'Research', nodeKind: 'agent', status: 'done', ms: 2440 })
  })

  it('renders a pruned branch as skipped with its reason', () => {
    const skipped = nodes(view.steps).find((step) => step.nodeId === 'n_direct')
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.reason).toBe('Router chose needs_research')
  })

  it('keeps edge transfers as their own ordered steps', () => {
    const chips = transfers(view.steps)
    expect(chips).toHaveLength(3)
    expect(chips[0]).toMatchObject({
      source: { node_id: 'n_in', port: 'message' },
      target: { node_id: 'n_route', port: 'input' },
      portType: 'text',
    })
  })

  it('pairs a tool call with its result', () => {
    const group = nodes(view.steps).find((step) => step.nodeId === 'n_research')
    const tool = group?.entries.find((entry): entry is ToolEntry => entry.type === 'tool')
    expect(tool).toMatchObject({ tool: 'web_search', pending: false, isError: false, ms: 412 })
    expect(tool?.input).toMatchObject({ max_results: 3 })
    expect(Array.isArray(tool?.output)).toBe(true)
  })

  it('records the router decision with the options it did not take', () => {
    const group = nodes(view.steps).find((step) => step.nodeId === 'n_route')
    const route = group?.entries.find((entry) => entry.type === 'route')
    expect(route).toMatchObject({
      chosen: 'needs_research',
      considered: ['needs_research', 'direct'],
    })
  })

  it('counts steps and tool calls for the collapsed summary', () => {
    expect(view.counts).toEqual({ nodes: 5, toolCalls: 1 })
    expect(summariseTimeline(view)).toBe('5 steps · 1 tool call')
  })

  it('preserves the order events happened in', () => {
    expect(view.steps.map((step) => (step.kind === 'node' ? step.nodeId : 'transfer'))).toEqual([
      'n_in',
      'transfer',
      'n_route',
      'n_direct',
      'transfer',
      'n_research',
      'transfer',
      'n_out',
    ])
  })
})

describe('reduceEvents — ordering and tolerance', () => {
  it('sorts by seq, not array position or ts', () => {
    const shuffled = [...research.events].reverse()
    expect(reduceEvents(shuffled).steps).toEqual(reduceEvents(research.events).steps)
  })

  it('does not mutate the events it is given', () => {
    const snapshot = structuredClone(math.events)
    reduceEvents(math.events)
    expect(math.events).toEqual(snapshot)
  })

  it('reports a run still in flight as running with an open node group', () => {
    const truncated = research.events.filter((event) => event.seq <= 12)
    const view = reduceEvents(truncated)
    expect(view.status).toBe('running')
    expect(nodes(view.steps).at(-1)?.status).toBe('running')
    expect(view.finalResponse).toBe('')
  })

  it('ignores event types it does not recognise', () => {
    const future = [
      ...math.events,
      {
        id: 'ev_future',
        run_id: 'run_2',
        seq: 999,
        ts: 1,
        author: 'system',
        type: 'thinking.delta',
        payload: { text: 'hmm' },
        partial: true,
        final: false,
      } as unknown as RunEvent,
    ]
    expect(() => reduceEvents(future)).not.toThrow()
    expect(reduceEvents(future).counts).toEqual(reduceEvents(math.events).counts)
  })

  it('synthesises a group when a node event arrives with no node.start', () => {
    const orphan = math.events.filter(
      (event) => !(event.type === 'node.start' && event.node_id === 'm_agent'),
    )
    const view = reduceEvents(orphan)
    const group = nodes(view.steps).find((step) => step.nodeId === 'm_agent')
    expect(group).toBeDefined()
    expect(group?.entries.some((entry) => entry.type === 'tool')).toBe(true)
  })

  it('returns an empty view for an empty log', () => {
    const view = reduceEvents([])
    expect(view).toMatchObject({ runId: null, steps: [], status: 'running' })
  })
})

describe('reduceEvents — streaming semantics', () => {
  const base = math.events.find((event) => event.type === 'text.message')!

  const delta = (seq: number, text: string): RunEvent => ({
    ...base,
    id: `d${seq}`,
    seq,
    type: 'text.delta',
    payload: { text },
    partial: true,
    final: false,
  })

  it('accumulates deltas for the same node into one message', () => {
    const events = [
      ...math.events.filter((e) => e.type !== 'text.message'),
      delta(100, 'Hel'),
      delta(101, 'lo'),
    ]
    const view = reduceEvents(events)
    const group = nodes(view.steps).find((step) => step.nodeId === 'm_agent')
    const message = group?.entries.find((entry): entry is MessageEntry => entry.type === 'message')
    expect(message).toMatchObject({ text: 'Hello', partial: true })
  })

  it('lets a later text.message replace what the deltas built', () => {
    const events = [
      ...math.events.filter((e) => e.type !== 'text.message'),
      delta(100, 'Hel'),
      delta(101, 'lo'),
      { ...base, id: 'final', seq: 102, payload: { text: 'Hello, world.' } },
    ]
    const view = reduceEvents(events)
    const group = nodes(view.steps).find((step) => step.nodeId === 'm_agent')
    const messages = group?.entries.filter((entry) => entry.type === 'message') ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ text: 'Hello, world.', partial: false })
  })
})

describe('reduceEvents — failures', () => {
  it('surfaces a failed tool result without failing the run', () => {
    const view = reduceEvents(buildToolErrorRun('run_3', 'divide by zero', START).events)
    const tool = nodes(view.steps)
      .flatMap((step) => step.entries)
      .find((entry): entry is ToolEntry => entry.type === 'tool')
    expect(tool).toMatchObject({ isError: true, pending: false })
    expect(view.status).toBe('ok')
    expect(view.finalResponse).not.toBe('')
  })

  it('marks a refused run as errored and keeps the code', () => {
    const view = reduceEvents(buildRefusalRun('run_4', 'refuse this', START).events)
    expect(view.status).toBe('error')
    expect(view.error).toMatchObject({ code: 'refusal', nodeId: 'n_route' })
    expect(view.finalResponse).toBe('')
  })

  it('stops the spinner on the node the run died in', () => {
    const view = reduceEvents(buildRefusalRun('run_5', 'refuse this', START).events)
    const open = nodes(view.steps).find((step) => step.nodeId === 'n_route')
    expect(open?.status).toBe('failed')
    expect(nodes(view.steps).some((step) => step.status === 'running')).toBe(false)
  })
})
