// Frontend-only types. Unlike src/types/api.ts these are ours, so they use
// camelCase and are free to change without a backend conversation.

import type { PortRef, RunEvent, Usage } from '@/types/events'

/* ── Timeline (the output of lib/events.ts) ──────────────────────────────── */

/**
 * A gated call's position in the review. Absent entirely on the ungated calls,
 * which is most of them — `undefined` means "no gate", not "not yet decided".
 */
export type ApprovalState = 'awaiting' | 'approved' | 'rejected'

export interface ToolEntry {
  type: 'tool'
  callId: string
  tool: string
  input: Record<string, unknown>
  /** Absent while the call is still in flight. */
  output?: unknown
  isError: boolean
  ms?: number
  pending: boolean
  approval?: ApprovalState
  /** The reviewer's reason, once they have given one. */
  approvalNote?: string
}

export interface RouteEntry {
  type: 'route'
  chosen: string
  reason: string
  considered: string[]
}

export interface MessageEntry {
  type: 'message'
  text: string
  /** True while only deltas have arrived — a `text.message` supersedes them. */
  partial: boolean
}

export interface LlmEntry {
  type: 'llm'
  iteration: number
  usage: Usage
  stopReason: string
}

export type NodeEntry = ToolEntry | RouteEntry | MessageEntry | LlmEntry

/**
 * `failed` = the run ended while this node was still open.
 * `awaiting` = it is holding a gated tool call and cannot move until a human
 * rules on it — a distinct state from `running`, because nothing is happening.
 */
export type NodeStatus = 'running' | 'done' | 'skipped' | 'failed' | 'awaiting'

export interface NodeStep {
  kind: 'node'
  /** Unique per occurrence, so a node that runs twice renders twice. */
  id: string
  nodeId: string
  nodeKind: string
  label: string
  status: NodeStatus
  ms?: number
  /** Why a skipped node was pruned. */
  reason?: string
  entries: NodeEntry[]
}

export interface TransferStep {
  kind: 'transfer'
  id: string
  source: PortRef
  target: PortRef
  portType: string
  preview: string
}

export type TimelineStep = NodeStep | TransferStep

export interface TimelineError {
  code: string
  message: string
  nodeId?: string
}

export interface TimelineView {
  runId: string | null
  workflowName: string | null
  /** `paused` = stopped at a gated tool call, waiting on a human. */
  status: 'running' | 'ok' | 'error' | 'paused'
  steps: TimelineStep[]
  finalResponse: string
  usage: Usage
  durationMs: number
  error: TimelineError | null
  /**
   * The calls still awaiting a verdict, derived from the log. The server sends
   * the same list on a paused run; deriving it here too is what lets a replayed
   * run render its pending approvals without a second request.
   */
  pendingApprovals: PendingApprovalEntry[]
  counts: { nodes: number; toolCalls: number }
}

export interface PendingApprovalEntry {
  callId: string
  nodeId: string | null
  tool: string
  input: Record<string, unknown>
}

/* ── Chat ────────────────────────────────────────────────────────────────── */

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Assistant turns carry the run that produced them, for the timeline. */
  runId?: string
  events?: RunEvent[]
  usage?: Usage
  durationMs?: number
  /**
   * `awaiting` = the run paused for approval. It is not `pending` (nothing is
   * running) and not `error` (nothing went wrong) — the distinction is what
   * stops the composer being disabled while a reviewer thinks.
   */
  status: 'pending' | 'ok' | 'error' | 'awaiting'
  /** Set when the request itself failed, before any events existed. */
  error?: { title: string; description?: string }
  /** The calls this turn is holding. Only present while `status === 'awaiting'`. */
  pendingApprovals?: PendingApprovalEntry[]
  /** True while a verdict is in flight, so the buttons can disable themselves. */
  resuming?: boolean
}
