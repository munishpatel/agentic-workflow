import type { RunEvent } from '@/types/events'
import type {
  MessageEntry,
  NodeStep,
  PendingApprovalEntry,
  TimelineStep,
  TimelineView,
  ToolEntry,
} from '@/types/ui'

/**
 * The one place run events are interpreted.
 *
 * Replaying a stored run and consuming a live stream both call this with the
 * same array, so a replay cannot drift from a live view. When the backend adds
 * SSE, the only thing that changes is what feeds this function — not the
 * function, and not the components that render its output.
 *
 * It is deliberately tolerant: events arrive in `seq` order but a partial log
 * (a run still in flight, or one that died mid-node) must still render.
 */
export function reduceEvents(events: RunEvent[]): TimelineView {
  const view: TimelineView = {
    runId: events[0]?.run_id ?? null,
    workflowName: null,
    status: 'running',
    steps: [],
    finalResponse: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    durationMs: 0,
    error: null,
    pendingApprovals: [],
    counts: { nodes: 0, toolCalls: 0 },
  }

  // Sort by seq, never by ts — timestamps can tie.
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  /**
   * The most recent group per node. Entries are never removed on `node.end`:
   * a trailing event for a node that has already finished belongs to the step
   * the user just watched, not to a phantom one appended at the bottom.
   */
  const latestGroups = new Map<string, NodeStep>()

  /**
   * Calls held by an `approval.required` that no `approval.decision` has yet
   * answered. A Map keyed by call id so a resumed run — which replays both
   * events — settles back to empty rather than double-counting.
   */
  const awaiting = new Map<string, PendingApprovalEntry>()

  function groupFor(nodeId: string | undefined): NodeStep | null {
    if (!nodeId) return null
    const existing = latestGroups.get(nodeId)
    if (existing) return existing
    // An event arrived for a node we never saw start — synthesise a group
    // rather than dropping the event on the floor.
    const group: NodeStep = {
      kind: 'node',
      id: `${nodeId}-orphan-${view.steps.length}`,
      nodeId,
      nodeKind: 'unknown',
      label: nodeId,
      status: 'running',
      entries: [],
    }
    latestGroups.set(nodeId, group)
    view.steps.push(group)
    view.counts.nodes += 1
    return group
  }

  for (const event of ordered) {
    switch (event.type) {
      case 'run.start': {
        view.workflowName = event.payload.workflow_name
        break
      }

      case 'run.end': {
        view.finalResponse = event.payload.final_response
        view.usage = event.payload.usage
        view.durationMs = event.payload.duration_ms
        if (view.status === 'running') view.status = 'ok'
        break
      }

      case 'run.error': {
        view.error = {
          code: event.payload.code,
          message: event.payload.message,
          ...(event.payload.node_id ? { nodeId: event.payload.node_id } : {}),
        }
        view.status = 'error'
        break
      }

      case 'node.start': {
        if (!event.node_id) break
        const group: NodeStep = {
          kind: 'node',
          id: `${event.node_id}-${event.seq}`,
          nodeId: event.node_id,
          nodeKind: event.payload.kind,
          label: event.payload.label,
          status: 'running',
          entries: [],
        }
        latestGroups.set(event.node_id, group)
        view.steps.push(group)
        view.counts.nodes += 1
        break
      }

      case 'node.end': {
        const group = groupFor(event.node_id)
        if (!group) break
        group.status = 'done'
        group.ms = event.payload.ms
        group.nodeKind = event.payload.kind
        group.label = event.payload.label
        break
      }

      case 'node.skipped': {
        if (!event.node_id) break
        view.steps.push({
          kind: 'node',
          id: `${event.node_id}-${event.seq}`,
          nodeId: event.node_id,
          nodeKind: event.payload.kind,
          label: event.payload.label,
          status: 'skipped',
          reason: event.payload.reason,
          entries: [],
        })
        view.counts.nodes += 1
        break
      }

      case 'edge.transfer': {
        const step: TimelineStep = {
          kind: 'transfer',
          id: `transfer-${event.seq}`,
          source: event.payload.source,
          target: event.payload.target,
          portType: event.payload.port_type,
          preview: event.payload.preview,
        }
        view.steps.push(step)
        break
      }

      case 'tool.call': {
        const group = groupFor(event.node_id)
        if (!group) break
        group.entries.push({
          type: 'tool',
          callId: event.payload.call_id,
          tool: event.payload.tool,
          input: event.payload.input,
          isError: false,
          pending: true,
        })
        view.counts.toolCalls += 1
        break
      }

      case 'tool.result': {
        const group = groupFor(event.node_id)
        if (!group) break
        const pending = group.entries.find(
          (entry): entry is ToolEntry =>
            entry.type === 'tool' && entry.callId === event.payload.call_id,
        )
        if (pending) {
          pending.output = event.payload.output
          pending.isError = event.payload.is_error
          pending.ms = event.payload.ms
          pending.pending = false
        } else {
          // A result with no matching call — still worth showing.
          group.entries.push({
            type: 'tool',
            callId: event.payload.call_id,
            tool: event.payload.tool,
            input: {},
            output: event.payload.output,
            isError: event.payload.is_error,
            ms: event.payload.ms,
            pending: false,
          })
          view.counts.toolCalls += 1
        }
        break
      }

      case 'approval.required': {
        const group = groupFor(event.node_id)
        // Mark the call the run is holding rather than appending a second
        // card — the reviewer needs to see the arguments in the tool call they
        // are ruling on, not next to it.
        const call = group?.entries.find(
          (entry): entry is ToolEntry =>
            entry.type === 'tool' && entry.callId === event.payload.call_id,
        )
        if (call) {
          call.approval = 'awaiting'
          call.pending = false
        }
        if (group) group.status = 'awaiting'
        awaiting.set(event.payload.call_id, {
          callId: event.payload.call_id,
          nodeId: event.node_id ?? null,
          tool: event.payload.tool,
          input: event.payload.input,
        })
        break
      }

      case 'approval.decision': {
        const group = groupFor(event.node_id)
        const call = group?.entries.find(
          (entry): entry is ToolEntry =>
            entry.type === 'tool' && entry.callId === event.payload.call_id,
        )
        if (call) {
          call.approval = event.payload.approved ? 'approved' : 'rejected'
          if (event.payload.note) call.approvalNote = event.payload.note
        }
        // Decided, so no longer awaiting — a resumed run replays both events
        // and must end up with an empty queue.
        awaiting.delete(event.payload.call_id)
        if (group && group.status === 'awaiting') group.status = 'running'
        break
      }

      case 'route.decision': {
        const group = groupFor(event.node_id)
        if (!group) break
        group.entries.push({
          type: 'route',
          chosen: event.payload.chosen,
          reason: event.payload.reason,
          considered: event.payload.considered,
        })
        break
      }

      case 'llm.response': {
        const group = groupFor(event.node_id)
        if (!group) break
        group.entries.push({
          type: 'llm',
          iteration: event.payload.iteration,
          usage: event.payload.usage,
          stopReason: event.payload.stop_reason,
        })
        break
      }

      case 'text.delta': {
        // v1 never sends these, but streaming is an additive change and the
        // reducer is the thing that must not need rewriting when it lands.
        const group = groupFor(event.node_id)
        if (!group) break
        const last = group.entries.at(-1)
        if (last?.type === 'message' && last.partial) {
          last.text += event.payload.text
        } else {
          group.entries.push({ type: 'message', text: event.payload.text, partial: true })
        }
        break
      }

      case 'text.message': {
        const group = groupFor(event.node_id)
        if (!group) break
        // The authoritative text replaces anything accumulated from deltas.
        const partial = [...group.entries]
          .reverse()
          .find((entry): entry is MessageEntry => entry.type === 'message' && entry.partial)
        if (partial) {
          partial.text = event.payload.text
          partial.partial = false
        } else {
          group.entries.push({ type: 'message', text: event.payload.text, partial: false })
        }
        break
      }

      case 'llm.request':
        // Carries no information the response doesn't, and showing both doubles
        // the timeline's length for no gain.
        break

      default: {
        // An event type this build does not know about. Ignoring it keeps an
        // older frontend working against a newer backend.
        break
      }
    }
  }

  // A run whose log stops mid-flight keeps its open groups as `running` — that
  // is what drives the live spinner. But once the run has failed, nothing is
  // still running, and a spinner that never resolves reads as a hung UI.
  if (view.status === 'error') {
    for (const step of view.steps) {
      if (step.kind === 'node' && step.status === 'running') step.status = 'failed'
    }
  }

  // Derived from the log, not from a field: a stored run replayed through
  // `GET /runs/{id}` gets its pending approvals here without the caller having
  // to thread the server's list in separately.
  view.pendingApprovals = [...awaiting.values()]
  if (view.pendingApprovals.length > 0 && view.status === 'running') {
    view.status = 'paused'
  }

  return view
}

/** "7 steps · 2 tool calls · 1.8s" — the collapsed timeline's summary line. */
export function summariseTimeline(view: TimelineView): string {
  const parts = [`${view.counts.nodes} ${view.counts.nodes === 1 ? 'step' : 'steps'}`]
  if (view.counts.toolCalls > 0) {
    parts.push(
      `${view.counts.toolCalls} ${view.counts.toolCalls === 1 ? 'tool call' : 'tool calls'}`,
    )
  }
  return parts.join(' · ')
}
