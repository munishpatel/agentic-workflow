// TEMPORARY: hand-authored mirror of the FastAPI contract.
// Phase 6 replaces this file with openapi-typescript output. Do not add
// frontend-only types here — those belong in src/types/ui.ts.
//
// Field names are snake_case because the backend is Python and we do not
// transform casing at the boundary. These types match the wire exactly.

import type { RunEvent, Usage } from './events'

export type { RunEvent, Usage }

/* ── JSON Schema ─────────────────────────────────────────────────────────── */

/**
 * The subset of JSON Schema draft-7 that `NodeConfigForm` understands. The
 * backend emits Pydantic's `model_json_schema()`, which is far richer; anything
 * outside this subset falls back to a raw JSON editor rather than being dropped.
 */
export interface JSONSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  format?: string
  /** Pydantic emits `$ref`/`$defs` for nested models. */
  $ref?: string
  $defs?: Record<string, JSONSchema>
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  allOf?: JSONSchema[]
  /** Our own hint, set via Pydantic's `json_schema_extra`. */
  'x-ui'?: string
  [key: string]: unknown
}

/* ── Graph ───────────────────────────────────────────────────────────────── */

export type PortType = 'text' | 'json' | 'number' | 'boolean' | 'any'

export interface PortSpec {
  name: string
  type: PortType
  required: boolean
  description: string
}

export type NodeKind = 'input' | 'agent' | 'tool' | 'router' | 'output'

export interface Position {
  x: number
  y: number
}

export interface WorkflowNode {
  /** Stable; referenced by edges. Client-generated on create. */
  id: string
  kind: NodeKind
  label: string
  /** Shape defined by the kind's `config_schema`. */
  config: Record<string, unknown>
  position: Position
}

export interface EdgeEnd {
  node_id: string
  port: string
}

export interface Edge {
  id: string
  source: EdgeEnd
  target: EdgeEnd
}

export interface Workflow {
  id: string
  name: string
  description: string | null
  /** "anthropic" */
  provider: string
  /** "claude-opus-5" */
  model: string
  /** Graph-wide persona, prepended for every agent node. */
  system_prompt: string
  nodes: WorkflowNode[]
  edges: Edge[]
  /** ISO 8601 */
  created_at: string
  updated_at: string
}

/** POST/PUT body — the server owns `id` and the timestamps. */
export type WorkflowInput = Omit<Workflow, 'id' | 'created_at' | 'updated_at'>

export interface WorkflowSummary {
  id: string
  name: string
  description: string | null
  model: string
  node_count: number
  tool_ids: string[]
  updated_at: string
}

/* ── Schema discovery ────────────────────────────────────────────────────── */

export interface NodeKindSpec {
  kind: NodeKind
  /** "Agent" */
  label: string
  description: string
  inputs: PortSpec[]
  /** "dynamic" → derived from config; see `lib/ports.ts`. */
  outputs: PortSpec[] | 'dynamic'
  config_schema: JSONSchema
}

export interface ToolMeta {
  /** "calculator" */
  id: string
  name: string
  description: string
  input_schema: JSONSchema
}

export interface ProviderMeta {
  /** "anthropic" */
  id: string
  label: string
  models: string[]
}

/* ── Validation ──────────────────────────────────────────────────────────── */

export interface ValidationIssue {
  /** "missing_output_node" | "cycle_detected" | "port_type_mismatch" | … */
  code: string
  message: string
  node_id?: string
  edge_id?: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/* ── Running ─────────────────────────────────────────────────────────────── */

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface RunRequest {
  message: string
  /** Prior turns, oldest first. */
  history: ChatTurn[]
}

export interface RunResponse {
  run_id: string
  final_response: string
  events: RunEvent[]
  usage: Usage
  duration_ms: number
}

export interface RunSummary {
  run_id: string
  user_message: string
  final_response: string
  created_at: string
  usage: Usage
  duration_ms: number
}

export interface SentEmail {
  id: string
  to: string
  subject: string
  body: string
  run_id: string
  created_at: string
}
