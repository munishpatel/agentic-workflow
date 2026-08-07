// The API contract, derived from the backend's own OpenAPI schema.
//
// `api.generated.ts` is regenerated with `npm run gen:api` and is the single
// source of truth for every wire shape. This file only gives those schemas the
// names the app uses, so a backend change that breaks an assumption here shows
// up as a compile error rather than a runtime surprise.
//
// Do not hand-edit shapes here. If something looks wrong, it is a contract
// question for the backend — fix it there and regenerate.
// Frontend-only types belong in src/types/ui.ts.

import type { components } from './api.generated'
import type { RunEvent, Usage } from './events'

export type { RunEvent, Usage }

type Schemas = components['schemas']

/* ── Graph ───────────────────────────────────────────────────────────────── */

export type PortType = 'text' | 'json' | 'number' | 'boolean' | 'any'
export type NodeKind = Schemas['Node']['kind']

export type PortSpec = {
  name: string
  type: PortType
  required: boolean
  description: string
}

export type Position = Schemas['Position']
export type EdgeEnd = Schemas['EdgeEnd']
export type Edge = Schemas['Edge']

/**
 * Named `WorkflowNode` rather than `Node` so it never collides with the DOM's
 * `Node` at a call site. `config` is optional on the wire (Pydantic gives it a
 * default) but the editor always writes one, so it is required here.
 */
export type WorkflowNode = Omit<Schemas['Node'], 'config' | 'position'> & {
  config: Record<string, unknown>
  position: Position
}

export type Workflow = Omit<Schemas['WorkflowRead'], 'nodes' | 'edges'> & {
  nodes: WorkflowNode[]
  edges: Edge[]
}

export type WorkflowInput = Omit<Schemas['WorkflowInput'], 'nodes' | 'edges'> & {
  nodes: WorkflowNode[]
  edges: Edge[]
}

export type WorkflowSummary = Schemas['WorkflowSummary']

/* ── Validation ──────────────────────────────────────────────────────────── */

export type ValidationIssue = Schemas['ValidationIssue']
export type ValidationResult = Schemas['ValidationResult']

/* ── Schema discovery ────────────────────────────────────────────────────── */

/**
 * The subset of JSON Schema draft-7 that `NodeConfigForm` understands. The
 * backend emits Pydantic's `model_json_schema()`, which is richer; anything
 * outside this subset falls back to a raw JSON editor rather than being lost.
 *
 * Not derived from the generated file: OpenAPI types `config_schema` as an
 * opaque object, so this is the frontend's own reading of what arrives in it.
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
  $ref?: string
  $defs?: Record<string, JSONSchema>
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  allOf?: JSONSchema[]
  /** Our own hint, set via Pydantic's `json_schema_extra`. */
  'x-ui'?: string
  [key: string]: unknown
}

export interface NodeKindSpec {
  kind: NodeKind
  label: string
  description: string
  inputs: PortSpec[]
  /** "dynamic" → derived from config; see `lib/ports.ts`. */
  outputs: PortSpec[] | 'dynamic'
  config_schema: JSONSchema
}

export type ToolMeta = Omit<Schemas['ToolMeta'], 'input_schema'> & {
  input_schema: JSONSchema
}

export type ProviderMeta = Schemas['ProviderMeta']

/* ── Running ─────────────────────────────────────────────────────────────── */

export type ChatTurn = Schemas['ChatTurn']
export type RunRequest = Schemas['RunRequest']

/**
 * The generated `events` are the envelope without a per-type payload; the app
 * narrows them through the discriminated union in `types/events.ts`, which is
 * what `reduceEvents` switches on.
 */
export type RunResponse = Omit<Schemas['RunResponse'], 'events'> & {
  events: RunEvent[]
}

export type RunSummary = Schemas['RunSummary']
export type SentEmail = Schemas['SentEmailRead']
