// TEMPORARY: hand-authored mirror of the FastAPI contract.
// Phase 6 replaces this file with openapi-typescript output. Do not add
// frontend-only types here — those belong in src/types/ui.ts.

/**
 * The run event envelope (frontend-plan.md §3.6).
 *
 * Every observable thing in a run is one of these, appended to an ordered log.
 * There is deliberately no per-concern event type: replaying a stored run and
 * consuming a future SSE stream produce the same array, so both go through the
 * same reducer (`lib/events.ts`) and cannot drift apart.
 */
export interface RunEventEnvelope {
  id: string
  run_id: string
  /** Monotonic total order within a run. Sort by this, never by `ts`. */
  seq: number
  /** Epoch seconds, float. */
  ts: number
  author: 'user' | 'system' | 'node'
  /** Absent on run-level events. */
  node_id?: string
  /** Sub-workflow nesting path; absent in v1. */
  branch?: string
  /** True when this is a delta and more is coming. */
  partial: boolean
  /** True when this is the last event for this (node_id, type) group. */
  final: boolean
}

export type RunEventType =
  | 'run.start'
  | 'run.end'
  | 'run.error'
  | 'node.start'
  | 'node.end'
  | 'node.skipped'
  | 'edge.transfer'
  | 'llm.request'
  | 'llm.response'
  | 'text.delta'
  | 'text.message'
  | 'tool.call'
  | 'tool.result'
  | 'route.decision'
  | 'approval.required'
  | 'approval.decision'

export interface Usage {
  input_tokens: number
  output_tokens: number
}

export interface PortRef {
  node_id: string
  port: string
}

export interface RunStartPayload {
  workflow_id: string
  workflow_name: string
}
export interface RunEndPayload {
  final_response: string
  usage: Usage
  duration_ms: number
}
export interface RunErrorPayload {
  code: string
  message: string
  node_id?: string
}
export interface NodeStartPayload {
  kind: string
  label: string
}
export interface NodeEndPayload extends NodeStartPayload {
  ms: number
}
export interface NodeSkippedPayload extends NodeStartPayload {
  reason: string
}
export interface EdgeTransferPayload {
  source: PortRef
  target: PortRef
  port_type: string
  /** A truncated string form of the value that crossed the edge. */
  preview: string
}
export interface LlmRequestPayload {
  iteration: number
  model: string
  tool_count: number
}
export interface LlmResponsePayload {
  iteration: number
  usage: Usage
  stop_reason: string
}
export interface TextDeltaPayload {
  text: string
}
export interface TextMessagePayload {
  text: string
}
export interface ToolCallPayload {
  call_id: string
  tool: string
  input: Record<string, unknown>
}
export interface ToolResultPayload {
  call_id: string
  tool: string
  output: unknown
  is_error: boolean
  ms: number
}
export interface RouteDecisionPayload {
  chosen: string
  reason: string
  considered: string[]
}
/**
 * A gated tool call stopped the run here. The matching `tool.result` only ever
 * follows an `approval.decision`, so "nothing ran unreviewed" is readable
 * straight off the log rather than taken on trust.
 */
export interface ApprovalRequiredPayload {
  call_id: string
  tool: string
  input: Record<string, unknown>
}
export interface ApprovalDecisionPayload {
  call_id: string
  tool: string
  approved: boolean
  /** The reviewer's reason. Passed to the model, so it may be shown verbatim. */
  note: string
}

type Event<T extends RunEventType, P> = RunEventEnvelope & { type: T; payload: P }

export type RunStartEvent = Event<'run.start', RunStartPayload>
export type RunEndEvent = Event<'run.end', RunEndPayload>
export type RunErrorEvent = Event<'run.error', RunErrorPayload>
export type NodeStartEvent = Event<'node.start', NodeStartPayload>
export type NodeEndEvent = Event<'node.end', NodeEndPayload>
export type NodeSkippedEvent = Event<'node.skipped', NodeSkippedPayload>
export type EdgeTransferEvent = Event<'edge.transfer', EdgeTransferPayload>
export type LlmRequestEvent = Event<'llm.request', LlmRequestPayload>
export type LlmResponseEvent = Event<'llm.response', LlmResponsePayload>
export type TextDeltaEvent = Event<'text.delta', TextDeltaPayload>
export type TextMessageEvent = Event<'text.message', TextMessagePayload>
export type ToolCallEvent = Event<'tool.call', ToolCallPayload>
export type ToolResultEvent = Event<'tool.result', ToolResultPayload>
export type RouteDecisionEvent = Event<'route.decision', RouteDecisionPayload>
export type ApprovalRequiredEvent = Event<'approval.required', ApprovalRequiredPayload>
export type ApprovalDecisionEvent = Event<'approval.decision', ApprovalDecisionPayload>

/**
 * Discriminated by `type`. The reducer still handles an unrecognised `type`
 * defensively — the backend is free to add event types without a frontend
 * release, and dropping one silently is better than throwing mid-timeline.
 */
export type RunEvent =
  | RunStartEvent
  | RunEndEvent
  | RunErrorEvent
  | NodeStartEvent
  | NodeEndEvent
  | NodeSkippedEvent
  | EdgeTransferEvent
  | LlmRequestEvent
  | LlmResponseEvent
  | TextDeltaEvent
  | TextMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | RouteDecisionEvent
  | ApprovalRequiredEvent
  | ApprovalDecisionEvent
