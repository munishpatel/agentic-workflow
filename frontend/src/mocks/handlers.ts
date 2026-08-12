import { HttpResponse, delay, http } from 'msw'
import type {
  ApprovalDecisionInput,
  RunRequest,
  Workflow,
  WorkflowInput,
  WorkflowSummary,
} from '@/types/api'
import type { RunEvent, ToolCallPayload } from '@/types/events'
import { createId } from '@/lib/utils'
import { FALLBACK_MODEL } from '@/lib/workflowDefaults'
import { mockDb, type StoredRun } from './db'
import {
  NODE_KINDS,
  PROVIDERS,
  TOOLS,
  buildEmailRun,
  buildMathRun,
  buildRefusalRun,
  buildResearchRun,
  buildToolErrorRun,
  type MockRun,
} from './fixtures'
import { validateWorkflow } from './validate'

/**
 * The whole API, in the browser (frontend-plan.md §7).
 *
 * Message keywords steer the mock runner so every path — including the ugly
 * ones — is reachable in a demo without touching code:
 *   "refuse"  → a run that ends in run.error
 *   "fail"    → a tool call that errors and an agent that recovers
 *   "email"   → a run that pauses at the gated send_email call
 *   "boom"    → HTTP 500
 *   "nokey"   → HTTP 401 missing_api_key
 */

const API = '*/api'

function apiError(status: number, code: string, message: string, details?: unknown) {
  return HttpResponse.json({ error: { code, message, details } }, { status })
}

function summarise(workflow: Workflow): WorkflowSummary {
  const toolIds = new Set<string>()
  for (const node of workflow.nodes) {
    const tools = node.config['tools']
    if (Array.isArray(tools)) {
      for (const tool of tools) if (typeof tool === 'string') toolIds.add(tool)
    }
    const toolId = node.config['tool_id']
    if (typeof toolId === 'string') toolIds.add(toolId)
  }
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    model: workflow.model,
    node_count: workflow.nodes.length,
    tool_ids: [...toolIds],
    updated_at: workflow.updated_at,
  }
}

function isWorkflowInput(value: unknown): value is WorkflowInput {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<WorkflowInput>
  return (
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  )
}

function pickRun(workflowId: string, message: string, runId: string, startedAt: number): MockRun {
  const lower = message.toLowerCase()
  if (lower.includes('refuse')) return buildRefusalRun(runId, message, startedAt)
  if (lower.includes('fail')) return buildToolErrorRun(runId, message, startedAt)
  // "email" is the demo's way into the approval gate — the run this returns
  // calls send_email, so the handler pauses it and asks.
  if (lower.includes('email')) return buildEmailRun(runId, message, startedAt)
  if (workflowId === 'wf_math') return buildMathRun(runId, message, startedAt)
  return buildResearchRun(runId, message, startedAt)
}

/** Tool ids the mock gates, mirroring `requires_approval` on the real registry. */
const GATED_TOOLS = new Set(TOOLS.filter((tool) => tool.requires_approval).map((tool) => tool.id))

interface GateSplit {
  before: RunEvent[]
  after: RunEvent[]
  call: ToolCallPayload
  nodeId: string | null
}

/**
 * Cut a scripted run at its first gated tool call.
 *
 * The `tool.call` stays in `before` — the reviewer needs to see it — and an
 * `approval.required` is appended after it. Everything from the matching
 * `tool.result` onwards is held back until a verdict arrives.
 */
function splitAtGatedCall(events: RunEvent[]): GateSplit | null {
  const index = events.findIndex(
    (event) => event.type === 'tool.call' && GATED_TOOLS.has(event.payload.tool),
  )
  if (index === -1) return null

  const call = events[index] as RunEvent & { type: 'tool.call' }
  const before = events.slice(0, index + 1)
  const after = events
    .slice(index + 1)
    // The held call's own result is replayed by the resume handler, not here.
    .filter(
      (event) => !(event.type === 'tool.result' && event.payload.call_id === call.payload.call_id),
    )

  before.push({
    id: createId('ev'),
    run_id: call.run_id,
    seq: (before.at(-1)?.seq ?? -1) + 1,
    ts: call.ts,
    author: 'system',
    node_id: call.node_id,
    type: 'approval.required',
    partial: false,
    final: true,
    payload: {
      call_id: call.payload.call_id,
      tool: call.payload.tool,
      input: call.payload.input,
    },
  })

  return { before, after, call: call.payload, nodeId: call.node_id ?? null }
}

/** Re-stamp held events so the resumed log stays strictly ordered by `seq`. */
function renumber(events: RunEvent[], nextSeq: () => number): RunEvent[] {
  return events.map((event) => ({ ...event, seq: nextSeq() }))
}

/** The `RunResponse` body, identical for start, resume and replay. */
function runBody(run: StoredRun) {
  return {
    run_id: run.run_id,
    final_response: run.final_response,
    events: run.events,
    usage: run.usage,
    duration_ms: run.duration_ms,
    status: run.status,
    pending_approvals: run.held
      ? [
          {
            call_id: run.held.call_id,
            node_id: run.held.node_id ?? '',
            tool: run.held.tool,
            input: run.held.input,
          },
        ]
      : [],
  }
}

export const handlers = [
  /* ── Schema discovery ─────────────────────────────────────────────────── */

  http.get(`${API}/node-kinds`, async () => {
    await delay(120)
    return HttpResponse.json(NODE_KINDS)
  }),

  http.get(`${API}/tools`, async () => {
    await delay(120)
    return HttpResponse.json(TOOLS)
  }),

  http.get(`${API}/providers`, async () => {
    await delay(120)
    return HttpResponse.json(PROVIDERS)
  }),

  /* ── Workflow CRUD ────────────────────────────────────────────────────── */

  http.get(`${API}/workflows`, async () => {
    await delay(320)
    const summaries = mockDb
      .workflows()
      .map(summarise)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return HttpResponse.json(summaries)
  }),

  http.post(`${API}/workflows`, async ({ request }) => {
    const body = await request.json()
    if (!isWorkflowInput(body)) {
      return apiError(422, 'validation_error', 'Expected a workflow body with nodes and edges.')
    }
    await delay(240)
    const now = new Date().toISOString()
    const workflow: Workflow = {
      ...body,
      // The real service normalises an absent description to null; the mock
      // must too, or the two disagree on a field the UI renders.
      description: body.description ?? null,
      // `model` is optional on the way in and always present on the way out —
      // the server fills it from its configured LLM_MODEL.
      model: body.model ?? FALLBACK_MODEL,
      id: createId('wf'),
      created_at: now,
      updated_at: now,
    }
    mockDb.insertWorkflow(workflow)
    return HttpResponse.json(workflow, { status: 201 })
  }),

  http.get(`${API}/workflows/:id`, async ({ params }) => {
    await delay(220)
    const workflow = mockDb.workflow(String(params['id']))
    if (!workflow) return apiError(404, 'not_found', 'That workflow does not exist.')
    return HttpResponse.json(workflow)
  }),

  http.put(`${API}/workflows/:id`, async ({ params, request }) => {
    const body = await request.json()
    if (!isWorkflowInput(body)) {
      return apiError(422, 'validation_error', 'Expected a workflow body with nodes and edges.')
    }
    const existing = mockDb.workflow(String(params['id']))
    if (!existing) return apiError(404, 'not_found', 'That workflow does not exist.')
    await delay(360)
    const updated: Workflow = {
      ...body,
      description: body.description ?? null,
      model: body.model ?? existing.model,
      id: existing.id,
      created_at: existing.created_at,
      updated_at: new Date().toISOString(),
    }
    mockDb.replaceWorkflow(updated)
    return HttpResponse.json(updated)
  }),

  http.delete(`${API}/workflows/:id`, async ({ params }) => {
    await delay(220)
    const removed = mockDb.deleteWorkflow(String(params['id']))
    if (!removed) return apiError(404, 'not_found', 'That workflow does not exist.')
    return new HttpResponse(null, { status: 204 })
  }),

  http.post(`${API}/workflows/:id/validate`, async ({ request }) => {
    const body = await request.json()
    if (!isWorkflowInput(body)) {
      return apiError(422, 'validation_error', 'Expected a workflow body with nodes and edges.')
    }
    await delay(180)
    return HttpResponse.json(validateWorkflow(body))
  }),

  /* ── Running ──────────────────────────────────────────────────────────── */

  http.post(`${API}/workflows/:id/run`, async ({ params, request }) => {
    const workflowId = String(params['id'])
    const workflow = mockDb.workflow(workflowId)
    if (!workflow) return apiError(404, 'not_found', 'That workflow does not exist.')

    const body = (await request.json()) as RunRequest
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    if (!message) return apiError(422, 'validation_error', 'A message is required.')

    const lower = message.toLowerCase()
    if (lower.includes('boom')) {
      await delay(400)
      return apiError(500, 'internal_error', 'The workflow engine crashed while executing a node.')
    }
    if (lower.includes('nokey')) {
      await delay(200)
      return apiError(401, 'missing_api_key', 'No provider credential is configured.')
    }

    await delay(900)

    const runId = createId('run')
    const startedAt = Date.now()
    const run = pickRun(workflowId, message, runId, startedAt)

    const gate = splitAtGatedCall(run.events)

    if (gate) {
      // Nothing is written to the outbox here. That is the whole point of the
      // gate, and a mock that sent anyway would teach the demo the wrong thing.
      const stored: StoredRun = {
        run_id: runId,
        workflow_id: workflowId,
        user_message: message,
        final_response: '',
        events: gate.before,
        usage: run.usage,
        duration_ms: run.duration_ms,
        created_at: new Date().toISOString(),
        status: 'paused',
        held: {
          call_id: gate.call.call_id,
          tool: gate.call.tool,
          input: gate.call.input,
          node_id: gate.nodeId,
          remainingEvents: gate.after,
          finalResponse: run.final_response,
        },
      }
      mockDb.insertRun(stored)
      return HttpResponse.json(runBody(stored))
    }

    const stored: StoredRun = {
      run_id: runId,
      workflow_id: workflowId,
      user_message: message,
      final_response: run.final_response,
      events: run.events,
      usage: run.usage,
      duration_ms: run.duration_ms,
      created_at: new Date().toISOString(),
      status: 'ok',
    }
    mockDb.insertRun(stored)
    return HttpResponse.json(runBody(stored))
  }),

  http.post(`${API}/runs/:runId/resume`, async ({ params, request }) => {
    const run = mockDb.run(String(params['runId']))
    if (!run) return apiError(404, 'not_found', 'That run does not exist.')
    if (run.status !== 'paused' || !run.held) {
      return apiError(409, 'run_not_paused', 'That run is not waiting for an approval.')
    }

    const body = (await request.json()) as { decisions?: ApprovalDecisionInput[] }
    const decisions = Array.isArray(body?.decisions) ? body.decisions : []
    const decision = decisions.find((entry) => entry.call_id === run.held?.call_id)
    if (!decision) {
      return apiError(
        422,
        'missing_decision',
        'Every held tool call needs an approve-or-reject decision before this run can continue.',
      )
    }

    await delay(700)

    const held = run.held
    const note = decision.note ?? ''
    let seq = (run.events.at(-1)?.seq ?? -1) + 1
    const next = (event: Omit<RunEvent, 'id' | 'run_id' | 'seq' | 'ts'>): RunEvent =>
      ({
        ...event,
        id: createId('ev'),
        run_id: run.run_id,
        seq: seq++,
        ts: Date.now() / 1000,
      }) as RunEvent

    const events: RunEvent[] = [
      ...run.events,
      next({
        type: 'approval.decision',
        author: 'system',
        node_id: held.node_id ?? undefined,
        partial: false,
        final: true,
        payload: {
          call_id: held.call_id,
          tool: held.tool,
          approved: decision.approved,
          note,
        },
      }),
    ]

    if (decision.approved) {
      events.push(...renumber(held.remainingEvents, () => seq++))
      mockDb.insertEmail({
        id: createId('em'),
        to: String(held.input['to'] ?? 'unknown@example.com'),
        subject: String(held.input['subject'] ?? '(no subject)'),
        body: String(held.input['body'] ?? ''),
        run_id: run.run_id,
        created_at: new Date().toISOString(),
      })
    } else {
      // A rejection produces an error-flagged result and a normal end, mirroring
      // the service: the run finishes, it just did not do the thing.
      events.push(
        next({
          type: 'tool.result',
          author: 'node',
          node_id: held.node_id ?? undefined,
          partial: false,
          final: true,
          payload: {
            call_id: held.call_id,
            tool: held.tool,
            output: `A human reviewer rejected this ${held.tool} call, so it did not run.${
              note ? ` Their note: ${note}` : ''
            }`,
            is_error: true,
            ms: 0,
          },
        }),
      )
    }

    const finalResponse = decision.approved
      ? held.finalResponse
      : 'I did not send that — a reviewer rejected it.'

    if (!decision.approved) {
      events.push(
        next({
          type: 'run.end',
          author: 'system',
          partial: false,
          final: true,
          payload: {
            final_response: finalResponse,
            usage: run.usage,
            duration_ms: run.duration_ms,
          },
        }),
      )
    }

    const resumed: StoredRun = {
      ...run,
      final_response: finalResponse,
      events,
      status: 'ok',
      held: undefined,
    }
    mockDb.replaceRun(resumed)
    return HttpResponse.json(runBody(resumed))
  }),

  http.get(`${API}/workflows/:id/runs`, async ({ params }) => {
    await delay(220)
    return HttpResponse.json(mockDb.runsFor(String(params['id'])))
  }),

  http.get(`${API}/runs/:runId`, async ({ params }) => {
    await delay(200)
    const run = mockDb.run(String(params['runId']))
    if (!run) return apiError(404, 'not_found', 'That run does not exist.')
    return HttpResponse.json(runBody(run))
  }),

  /* ── Mock outbox ──────────────────────────────────────────────────────── */

  http.get(`${API}/emails`, async () => {
    await delay(220)
    return HttpResponse.json(mockDb.emails())
  }),
]
