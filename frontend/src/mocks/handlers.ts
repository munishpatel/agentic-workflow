import { HttpResponse, delay, http } from 'msw'
import type {
  RunRequest,
  SentEmail,
  Workflow,
  WorkflowInput,
  WorkflowSummary,
} from '@/types/api'
import { createId } from '@/lib/utils'
import { mockDb, type StoredRun } from './db'
import {
  NODE_KINDS,
  PROVIDERS,
  TOOLS,
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
  if (workflowId === 'wf_math') return buildMathRun(runId, message, startedAt)
  return buildResearchRun(runId, message, startedAt)
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
    const workflow: Workflow = { ...body, id: createId('wf'), created_at: now, updated_at: now }
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

    const stored: StoredRun = {
      run_id: runId,
      workflow_id: workflowId,
      user_message: message,
      final_response: run.final_response,
      events: run.events,
      usage: run.usage,
      duration_ms: run.duration_ms,
      created_at: new Date().toISOString(),
    }
    mockDb.insertRun(stored)

    // Any send_email tool call in this run lands in the mock outbox.
    for (const event of run.events) {
      if (event.type !== 'tool.call' || event.payload.tool !== 'send_email') continue
      const input = event.payload.input
      const email: SentEmail = {
        id: createId('em'),
        to: String(input['to'] ?? 'unknown@example.com'),
        subject: String(input['subject'] ?? '(no subject)'),
        body: String(input['body'] ?? ''),
        run_id: runId,
        created_at: new Date().toISOString(),
      }
      mockDb.insertEmail(email)
    }

    return HttpResponse.json({
      run_id: runId,
      final_response: run.final_response,
      events: run.events,
      usage: run.usage,
      duration_ms: run.duration_ms,
    })
  }),

  http.get(`${API}/workflows/:id/runs`, async ({ params }) => {
    await delay(220)
    return HttpResponse.json(mockDb.runsFor(String(params['id'])))
  }),

  http.get(`${API}/runs/:runId`, async ({ params }) => {
    await delay(200)
    const run = mockDb.run(String(params['runId']))
    if (!run) return apiError(404, 'not_found', 'That run does not exist.')
    return HttpResponse.json({
      run_id: run.run_id,
      final_response: run.final_response,
      events: run.events,
      usage: run.usage,
      duration_ms: run.duration_ms,
    })
  }),

  /* ── Mock outbox ──────────────────────────────────────────────────────── */

  http.get(`${API}/emails`, async () => {
    await delay(220)
    return HttpResponse.json(mockDb.emails())
  }),
]
