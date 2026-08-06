// Frontend-only types. Unlike src/types/api.ts these are ours, so they use
// camelCase and are free to change without a backend conversation.

import type { PortRef, RunEvent, Usage } from '@/types/events'

/* ── Timeline (the output of lib/events.ts) ──────────────────────────────── */

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

/** `failed` = the run ended while this node was still open. */
export type NodeStatus = 'running' | 'done' | 'skipped' | 'failed'

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
  status: 'running' | 'ok' | 'error'
  steps: TimelineStep[]
  finalResponse: string
  usage: Usage
  durationMs: number
  error: TimelineError | null
  counts: { nodes: number; toolCalls: number }
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
  status: 'pending' | 'ok' | 'error'
  /** Set when the request itself failed, before any events existed. */
  error?: { title: string; description?: string }
}
