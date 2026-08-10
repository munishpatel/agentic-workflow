import type { NodeKindSpec, ProviderMeta, ToolMeta, Workflow } from '@/types/api'
import type { RunEvent, RunEventType, Usage } from '@/types/events'

/* ── Schema discovery fixtures ───────────────────────────────────────────── */

const TOOL_IDS = ['calculator', 'web_search', 'send_email', 'current_datetime']

export const NODE_KINDS: NodeKindSpec[] = [
  {
    kind: 'input',
    label: 'Input',
    description: 'Graph entry. Emits the user’s turn. Exactly one per workflow.',
    inputs: [],
    outputs: [
      { name: 'message', type: 'text', required: true, description: 'The user’s message.' },
      { name: 'history', type: 'json', required: false, description: 'Prior turns in this chat.' },
    ],
    config_schema: { type: 'object', properties: {} },
  },
  {
    kind: 'agent',
    label: 'Agent',
    description: 'Runs the tool-use loop with its own instruction and tool subset.',
    inputs: [
      { name: 'prompt', type: 'text', required: true, description: 'What this agent works on.' },
      {
        name: 'context',
        type: 'any',
        required: false,
        description: 'Extra material appended to the prompt.',
      },
    ],
    outputs: [
      { name: 'text', type: 'text', required: true, description: 'The agent’s final text.' },
    ],
    config_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          title: 'Instruction',
          description:
            'The task for this node. Composed with the workflow’s system prompt: persona is graph-wide, task is node-local.',
          'x-ui': 'textarea',
          default: '',
        },
        tools: {
          type: 'array',
          title: 'Tools',
          description: 'Tools this agent may call. Leave empty for a pure-reasoning step.',
          items: { type: 'string', enum: TOOL_IDS },
          default: [],
        },
        max_tool_iterations: {
          type: 'integer',
          title: 'Max tool iterations',
          description: 'Safety cap on the tool-use loop.',
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ['instruction'],
    },
  },
  {
    kind: 'tool',
    label: 'Tool',
    description: 'Calls one registry tool deterministically — no model in the path.',
    inputs: [
      {
        name: 'args',
        type: 'json',
        required: false,
        description: 'Arguments, overriding the literal values configured below.',
      },
    ],
    outputs: [{ name: 'result', type: 'text', required: true, description: 'The tool’s output.' }],
    config_schema: {
      type: 'object',
      properties: {
        tool_id: {
          type: 'string',
          title: 'Tool',
          description: 'Which registry tool to call.',
          enum: TOOL_IDS,
        },
        args: {
          type: 'object',
          title: 'Arguments',
          description: 'Literal arguments for the selected tool.',
          default: {},
        },
      },
      required: ['tool_id'],
    },
  },
  {
    kind: 'router',
    label: 'Router',
    description: 'Classifies its input into exactly one route. Only that branch runs.',
    inputs: [{ name: 'input', type: 'text', required: true, description: 'The text to classify.' }],
    outputs: 'dynamic',
    config_schema: {
      type: 'object',
      properties: {
        routes: {
          type: 'array',
          title: 'Routes',
          description: 'Each route becomes an output port. Describe when to choose it.',
          minItems: 2,
          default: [],
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                title: 'Label',
                description: 'Port name, e.g. needs_research.',
              },
              description: {
                type: 'string',
                title: 'Choose when',
                description: 'How the model decides this route applies.',
                'x-ui': 'textarea',
              },
            },
            required: ['label', 'description'],
          },
        },
      },
      required: ['routes'],
    },
  },
  {
    kind: 'output',
    label: 'Output',
    description: 'Terminal node. Its value is the chat reply. Exactly one per workflow.',
    inputs: [
      { name: 'response', type: 'text', required: true, description: 'The reply to the user.' },
    ],
    outputs: [],
    config_schema: { type: 'object', properties: {} },
  },
]

export const TOOLS: ToolMeta[] = [
  {
    id: 'calculator',
    name: 'Calculator',
    description:
      'Evaluate an arithmetic expression. Use whenever a number must be exact rather than estimated.',
    input_schema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          title: 'Expression',
          description: 'Arithmetic only, e.g. (1200 * 1.08) / 3.',
        },
      },
      required: ['expression'],
    },
    requires_approval: false,
  },
  {
    id: 'web_search',
    name: 'Web search',
    description:
      'Search the web and return the top results. Use for current events, prices, or anything that changes.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', title: 'Query', description: 'What to search for.' },
        max_results: {
          type: 'integer',
          title: 'Max results',
          minimum: 1,
          maximum: 10,
          default: 3,
        },
      },
      required: ['query'],
    },
    requires_approval: false,
  },
  {
    id: 'send_email',
    name: 'Send email',
    description:
      'Send an email. Mocked — the message is written to the outbox and nothing leaves the machine.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', title: 'To', format: 'email' },
        subject: { type: 'string', title: 'Subject' },
        body: { type: 'string', title: 'Body', 'x-ui': 'textarea' },
      },
      required: ['to', 'subject', 'body'],
    },
    // The one gated tool: the engine pauses the run at this call and will not
    // execute it without a human verdict.
    requires_approval: true,
  },
  {
    id: 'current_datetime',
    name: 'Current date and time',
    description: 'The current time in an IANA timezone. Use to ground anything time-relative.',
    input_schema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          title: 'Timezone',
          description: 'IANA name, e.g. Europe/London.',
          default: 'UTC',
        },
      },
    },
    requires_approval: false,
  },
]

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
]

/* ── Seed workflows ──────────────────────────────────────────────────────── */

const RESEARCH: Workflow = {
  id: 'wf_research',
  name: 'Research assistant',
  description: 'Triages a question, researches it on the web when it needs current facts.',
  provider: 'anthropic',
  model: 'claude-opus-5',
  system_prompt:
    'You are a precise research assistant. Prefer primary sources, cite what you used, and say plainly when you are unsure.',
  nodes: [
    { id: 'n_in', kind: 'input', label: 'Start', config: {}, position: { x: 40, y: 220 } },
    {
      id: 'n_route',
      kind: 'router',
      label: 'Triage',
      config: {
        routes: [
          {
            label: 'needs_research',
            description:
              'The question depends on current facts, prices, news or sources that change over time.',
          },
          {
            label: 'direct',
            description: 'The question can be answered from general knowledge alone.',
          },
        ],
      },
      position: { x: 300, y: 220 },
    },
    {
      id: 'n_research',
      kind: 'agent',
      label: 'Research',
      config: {
        instruction:
          'Search the web for the question, read the top results, and answer with the sources you used.',
        tools: ['web_search'],
        max_tool_iterations: 4,
      },
      position: { x: 600, y: 80 },
    },
    {
      id: 'n_direct',
      kind: 'agent',
      label: 'Answer directly',
      config: {
        instruction: 'Answer the question from what you already know. Be brief.',
        tools: [],
        max_tool_iterations: 1,
      },
      position: { x: 600, y: 380 },
    },
    { id: 'n_out', kind: 'output', label: 'Reply', config: {}, position: { x: 900, y: 220 } },
  ],
  edges: [
    {
      id: 'e_in_route',
      source: { node_id: 'n_in', port: 'message' },
      target: { node_id: 'n_route', port: 'input' },
    },
    {
      id: 'e_route_research',
      source: { node_id: 'n_route', port: 'needs_research' },
      target: { node_id: 'n_research', port: 'prompt' },
    },
    {
      id: 'e_route_direct',
      source: { node_id: 'n_route', port: 'direct' },
      target: { node_id: 'n_direct', port: 'prompt' },
    },
    {
      id: 'e_research_out',
      source: { node_id: 'n_research', port: 'text' },
      target: { node_id: 'n_out', port: 'response' },
    },
    {
      id: 'e_direct_out',
      source: { node_id: 'n_direct', port: 'text' },
      target: { node_id: 'n_out', port: 'response' },
    },
  ],
  created_at: '2026-07-28T09:12:00.000Z',
  updated_at: '2026-08-02T16:41:00.000Z',
}

const MATH: Workflow = {
  id: 'wf_math',
  name: 'Math helper',
  description: 'One agent with a calculator. The minimal useful graph.',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  system_prompt: 'You are a careful maths tutor. Show the steps, then the answer.',
  nodes: [
    { id: 'm_in', kind: 'input', label: 'Start', config: {}, position: { x: 60, y: 180 } },
    {
      id: 'm_agent',
      kind: 'agent',
      label: 'Calculate',
      config: {
        instruction:
          'Work through the problem step by step. Use the calculator for every arithmetic step rather than doing it in your head.',
        tools: ['calculator'],
        max_tool_iterations: 6,
      },
      position: { x: 380, y: 180 },
    },
    { id: 'm_out', kind: 'output', label: 'Reply', config: {}, position: { x: 720, y: 180 } },
  ],
  edges: [
    {
      id: 'm_e1',
      source: { node_id: 'm_in', port: 'message' },
      target: { node_id: 'm_agent', port: 'prompt' },
    },
    {
      id: 'm_e2',
      source: { node_id: 'm_agent', port: 'text' },
      target: { node_id: 'm_out', port: 'response' },
    },
  ],
  created_at: '2026-07-30T11:02:00.000Z',
  updated_at: '2026-07-31T08:15:00.000Z',
}

export const SEED_WORKFLOWS: Workflow[] = [RESEARCH, MATH]

/* ── Run event fixtures ──────────────────────────────────────────────────── */

/**
 * Builds an ordered `RunEvent[]` the way the backend will: one monotonic `seq`
 * per event, run-level events with no `node_id`, node events in start/end pairs.
 * These fixtures are also the input to the `reduceEvents` unit tests, so the
 * reducer is exercised against the same shape the UI renders.
 */
class EventLog {
  private seq = 0
  private ts: number
  private runId: string
  events: RunEvent[] = []

  constructor(runId: string, startedAt: number) {
    this.runId = runId
    this.ts = startedAt / 1000
  }

  private push<T extends RunEventType, P>(
    type: T,
    payload: P,
    extra: { node_id?: string; author?: RunEvent['author']; ms?: number } = {},
  ) {
    const { node_id, author = node_id ? 'node' : 'system', ms = 0 } = extra
    this.ts += ms / 1000
    this.events.push({
      id: `ev_${this.runId}_${this.seq}`,
      run_id: this.runId,
      seq: this.seq++,
      ts: Number(this.ts.toFixed(3)),
      author,
      ...(node_id ? { node_id } : {}),
      type,
      payload,
      partial: false,
      final: true,
    } as RunEvent)
  }

  runStart(workflowId: string, workflowName: string) {
    this.push('run.start', { workflow_id: workflowId, workflow_name: workflowName })
  }
  runEnd(finalResponse: string, usage: Usage, durationMs: number) {
    this.push('run.end', { final_response: finalResponse, usage, duration_ms: durationMs })
  }
  runError(code: string, message: string, nodeId?: string) {
    this.push('run.error', { code, message, ...(nodeId ? { node_id: nodeId } : {}) })
  }
  nodeStart(nodeId: string, kind: string, label: string) {
    this.push('node.start', { kind, label }, { node_id: nodeId })
  }
  nodeEnd(nodeId: string, kind: string, label: string, ms: number) {
    this.push('node.end', { kind, label, ms }, { node_id: nodeId, ms })
  }
  nodeSkipped(nodeId: string, kind: string, label: string, reason: string) {
    this.push('node.skipped', { kind, label, reason }, { node_id: nodeId })
  }
  edgeTransfer(
    source: { node_id: string; port: string },
    target: { node_id: string; port: string },
    portType: string,
    preview: string,
  ) {
    this.push('edge.transfer', { source, target, port_type: portType, preview })
  }
  llmRequest(nodeId: string, iteration: number, model: string, toolCount: number) {
    this.push('llm.request', { iteration, model, tool_count: toolCount }, { node_id: nodeId })
  }
  llmResponse(nodeId: string, iteration: number, usage: Usage, stopReason: string, ms: number) {
    this.push(
      'llm.response',
      { iteration, usage, stop_reason: stopReason },
      { node_id: nodeId, ms },
    )
  }
  textMessage(nodeId: string, text: string) {
    this.push('text.message', { text }, { node_id: nodeId })
  }
  toolCall(nodeId: string, callId: string, tool: string, input: Record<string, unknown>) {
    this.push('tool.call', { call_id: callId, tool, input }, { node_id: nodeId })
  }
  toolResult(
    nodeId: string,
    callId: string,
    tool: string,
    output: unknown,
    isError: boolean,
    ms: number,
  ) {
    this.push(
      'tool.result',
      { call_id: callId, tool, output, is_error: isError, ms },
      { node_id: nodeId, ms },
    )
  }
  routeDecision(nodeId: string, chosen: string, reason: string, considered: string[]) {
    this.push('route.decision', { chosen, reason, considered }, { node_id: nodeId })
  }
}

export interface MockRun {
  events: RunEvent[]
  final_response: string
  usage: Usage
  duration_ms: number
}

const SEARCH_RESULTS = [
  {
    title: 'Typed connections in agent graphs — an overview',
    url: 'https://example.com/typed-agent-graphs',
    snippet:
      'Declaring node ports with types lets a builder reject invalid wiring before a run ever starts.',
  },
  {
    title: 'Event envelopes and replayable runs',
    url: 'https://example.com/event-envelopes',
    snippet:
      'A single append-only event type keeps live streaming and stored replay on one code path.',
  },
  {
    title: 'Router nodes and branch pruning',
    url: 'https://example.com/router-nodes',
    snippet: 'Classify once, activate one branch, and record the decision for the transcript.',
  },
]

/** `input → router → research agent (web_search) → output`, with `direct` pruned. */
export function buildResearchRun(runId: string, message: string, startedAt: number): MockRun {
  const log = new EventLog(runId, startedAt)
  const model = RESEARCH.model
  const answer =
    `Here’s what I found on “${message}”.\n\n` +
    'Typed ports let the builder reject invalid wiring up front, and a single event envelope keeps ' +
    'live runs and stored replays on the same code path.\n\n' +
    'Sources:\n' +
    SEARCH_RESULTS.map((r) => `- ${r.title} — ${r.url}`).join('\n')

  log.runStart(RESEARCH.id, RESEARCH.name)

  log.nodeStart('n_in', 'input', 'Start')
  log.nodeEnd('n_in', 'input', 'Start', 2)
  log.edgeTransfer(
    { node_id: 'n_in', port: 'message' },
    { node_id: 'n_route', port: 'input' },
    'text',
    message,
  )

  log.nodeStart('n_route', 'router', 'Triage')
  log.llmRequest('n_route', 1, model, 0)
  log.llmResponse('n_route', 1, { input_tokens: 412, output_tokens: 38 }, 'end', 610)
  log.routeDecision(
    'n_route',
    'needs_research',
    'The question asks about current material rather than settled general knowledge, so the web branch applies.',
    ['needs_research', 'direct'],
  )
  log.nodeEnd('n_route', 'router', 'Triage', 618)

  log.nodeSkipped('n_direct', 'agent', 'Answer directly', 'Router chose needs_research')
  log.edgeTransfer(
    { node_id: 'n_route', port: 'needs_research' },
    { node_id: 'n_research', port: 'prompt' },
    'text',
    message,
  )

  log.nodeStart('n_research', 'agent', 'Research')
  log.llmRequest('n_research', 1, model, 1)
  log.llmResponse('n_research', 1, { input_tokens: 986, output_tokens: 74 }, 'tool_call', 840)
  log.toolCall('n_research', 'call_ws_1', 'web_search', { query: message, max_results: 3 })
  log.toolResult('n_research', 'call_ws_1', 'web_search', SEARCH_RESULTS, false, 412)
  log.llmRequest('n_research', 2, model, 1)
  log.llmResponse('n_research', 2, { input_tokens: 1420, output_tokens: 260 }, 'end', 1180)
  log.textMessage('n_research', answer)
  log.nodeEnd('n_research', 'agent', 'Research', 2440)

  log.edgeTransfer(
    { node_id: 'n_research', port: 'text' },
    { node_id: 'n_out', port: 'response' },
    'text',
    answer,
  )
  log.nodeStart('n_out', 'output', 'Reply')
  log.nodeEnd('n_out', 'output', 'Reply', 1)

  const usage = { input_tokens: 2818, output_tokens: 372 }
  const duration = 3140
  log.runEnd(answer, usage, duration)

  return { events: log.events, final_response: answer, usage, duration_ms: duration }
}

/** `input → agent (calculator) → output`. */
export function buildMathRun(runId: string, message: string, startedAt: number): MockRun {
  const log = new EventLog(runId, startedAt)
  const model = MATH.model
  const answer =
    'Working through it:\n\n1. 1200 × 1.08 = 1296\n2. 1296 ÷ 3 = 432\n\n**432** is the answer.'

  log.runStart(MATH.id, MATH.name)
  log.nodeStart('m_in', 'input', 'Start')
  log.nodeEnd('m_in', 'input', 'Start', 1)
  log.edgeTransfer(
    { node_id: 'm_in', port: 'message' },
    { node_id: 'm_agent', port: 'prompt' },
    'text',
    message,
  )

  log.nodeStart('m_agent', 'agent', 'Calculate')
  log.llmRequest('m_agent', 1, model, 1)
  log.llmResponse('m_agent', 1, { input_tokens: 520, output_tokens: 60 }, 'tool_call', 520)
  log.toolCall('m_agent', 'call_calc_1', 'calculator', { expression: '1200 * 1.08' })
  log.toolResult('m_agent', 'call_calc_1', 'calculator', '1296', false, 3)
  log.llmRequest('m_agent', 2, model, 1)
  log.llmResponse('m_agent', 2, { input_tokens: 640, output_tokens: 48 }, 'tool_call', 480)
  log.toolCall('m_agent', 'call_calc_2', 'calculator', { expression: '1296 / 3' })
  log.toolResult('m_agent', 'call_calc_2', 'calculator', '432', false, 2)
  log.llmRequest('m_agent', 3, model, 1)
  log.llmResponse('m_agent', 3, { input_tokens: 760, output_tokens: 96 }, 'end', 700)
  log.textMessage('m_agent', answer)
  log.nodeEnd('m_agent', 'agent', 'Calculate', 1760)

  log.edgeTransfer(
    { node_id: 'm_agent', port: 'text' },
    { node_id: 'm_out', port: 'response' },
    'text',
    answer,
  )
  log.nodeStart('m_out', 'output', 'Reply')
  log.nodeEnd('m_out', 'output', 'Reply', 1)

  const usage = { input_tokens: 1920, output_tokens: 204 }
  const duration = 1830
  log.runEnd(answer, usage, duration)

  return { events: log.events, final_response: answer, usage, duration_ms: duration }
}

/**
 * A run that calls the one gated tool.
 *
 * Written as an ordinary complete run — `send_email` called, result, answer.
 * The handler is what cuts it at the gated call and holds the rest back, which
 * keeps the fixture honest about what the workflow *would* do and keeps the
 * pausing logic in exactly one place.
 */
export function buildEmailRun(runId: string, message: string, startedAt: number): MockRun {
  const log = new EventLog(runId, startedAt)
  const answer =
    'Sent. The digest went to **team@example.com** with the subject “Weekly research digest”.'

  log.runStart(MATH.id, MATH.name)
  log.nodeStart('m_in', 'input', 'Start')
  log.nodeEnd('m_in', 'input', 'Start', 1)
  log.edgeTransfer(
    { node_id: 'm_in', port: 'message' },
    { node_id: 'm_agent', port: 'prompt' },
    'text',
    message,
  )

  log.nodeStart('m_agent', 'agent', 'Calculate')
  log.llmRequest('m_agent', 1, MATH.model, 2)
  log.llmResponse('m_agent', 1, { input_tokens: 610, output_tokens: 88 }, 'tool_call', 640)
  log.toolCall('m_agent', 'call_email_1', 'send_email', {
    to: 'team@example.com',
    subject: 'Weekly research digest',
    body: 'Three sources on typed agent graphs, summarised.',
  })
  log.toolResult(
    'm_agent',
    'call_email_1',
    'send_email',
    'Email recorded for team@example.com with subject “Weekly research digest”. This environment mocks delivery — nothing was actually sent.',
    false,
    6,
  )
  log.llmRequest('m_agent', 2, MATH.model, 2)
  log.llmResponse('m_agent', 2, { input_tokens: 780, output_tokens: 64 }, 'end', 520)
  log.textMessage('m_agent', answer)
  log.nodeEnd('m_agent', 'agent', 'Calculate', 1240)

  log.edgeTransfer(
    { node_id: 'm_agent', port: 'text' },
    { node_id: 'm_out', port: 'response' },
    'text',
    answer,
  )
  log.nodeStart('m_out', 'output', 'Reply')
  log.nodeEnd('m_out', 'output', 'Reply', 1)

  const usage = { input_tokens: 1390, output_tokens: 152 }
  const duration = 1420
  log.runEnd(answer, usage, duration)

  return { events: log.events, final_response: answer, usage, duration_ms: duration }
}

/**
 * A run where the tool fails and the agent recovers. Error paths are otherwise
 * the last thing built and the first thing a reviewer hits.
 */
export function buildToolErrorRun(runId: string, message: string, startedAt: number): MockRun {
  const log = new EventLog(runId, startedAt)
  const answer =
    'That expression isn’t something I can evaluate — it divides by zero. Give me a different one and I’ll work it through.'

  log.runStart(MATH.id, MATH.name)
  log.nodeStart('m_in', 'input', 'Start')
  log.nodeEnd('m_in', 'input', 'Start', 1)
  log.edgeTransfer(
    { node_id: 'm_in', port: 'message' },
    { node_id: 'm_agent', port: 'prompt' },
    'text',
    message,
  )
  log.nodeStart('m_agent', 'agent', 'Calculate')
  log.llmRequest('m_agent', 1, MATH.model, 1)
  log.llmResponse('m_agent', 1, { input_tokens: 480, output_tokens: 52 }, 'tool_call', 500)
  log.toolCall('m_agent', 'call_calc_err', 'calculator', { expression: '1 / 0' })
  log.toolResult(
    'm_agent',
    'call_calc_err',
    'calculator',
    'ZeroDivisionError: division by zero',
    true,
    4,
  )
  log.llmRequest('m_agent', 2, MATH.model, 1)
  log.llmResponse('m_agent', 2, { input_tokens: 610, output_tokens: 64 }, 'end', 640)
  log.textMessage('m_agent', answer)
  log.nodeEnd('m_agent', 'agent', 'Calculate', 1180)
  log.edgeTransfer(
    { node_id: 'm_agent', port: 'text' },
    { node_id: 'm_out', port: 'response' },
    'text',
    answer,
  )
  log.nodeStart('m_out', 'output', 'Reply')
  log.nodeEnd('m_out', 'output', 'Reply', 1)

  const usage = { input_tokens: 1090, output_tokens: 116 }
  const duration = 1210
  log.runEnd(answer, usage, duration)
  return { events: log.events, final_response: answer, usage, duration_ms: duration }
}

/** A run that ends in `run.error` — the model declined. */
export function buildRefusalRun(runId: string, message: string, startedAt: number): MockRun {
  const log = new EventLog(runId, startedAt)
  log.runStart(RESEARCH.id, RESEARCH.name)
  log.nodeStart('n_in', 'input', 'Start')
  log.nodeEnd('n_in', 'input', 'Start', 1)
  log.edgeTransfer(
    { node_id: 'n_in', port: 'message' },
    { node_id: 'n_route', port: 'input' },
    'text',
    message,
  )
  log.nodeStart('n_route', 'router', 'Triage')
  log.llmRequest('n_route', 1, RESEARCH.model, 0)
  log.llmResponse('n_route', 1, { input_tokens: 380, output_tokens: 12 }, 'refusal', 420)
  log.runError('refusal', 'The model declined to respond to this request.', 'n_route')
  return {
    events: log.events,
    final_response: '',
    usage: { input_tokens: 380, output_tokens: 12 },
    duration_ms: 470,
  }
}
