import type { NodeKind, NodeKindSpec, WorkflowInput, WorkflowNode } from '@/types/api'
import { createId } from '@/lib/utils'

export const FALLBACK_PROVIDER = 'anthropic'
export const FALLBACK_MODEL = 'claude-opus-5'

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Be accurate, be brief, and say plainly when you are unsure.'

/**
 * A new workflow starts as the smallest graph that is valid and runnable:
 * `input → agent → output`. Starting from an empty canvas means the first thing
 * a user sees is a wall of validation errors.
 */
export function newWorkflowInput(fields: {
  name: string
  description: string
  provider?: string
  model?: string
}): WorkflowInput {
  const inputId = createId('n')
  const agentId = createId('n')
  const outputId = createId('n')

  return {
    name: fields.name,
    description: fields.description.trim() || null,
    provider: fields.provider ?? FALLBACK_PROVIDER,
    model: fields.model ?? FALLBACK_MODEL,
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    nodes: [
      { id: inputId, kind: 'input', label: 'Start', config: {}, position: { x: 80, y: 200 } },
      {
        id: agentId,
        kind: 'agent',
        label: 'Agent',
        config: { instruction: '', tools: [], max_tool_iterations: 5 },
        position: { x: 420, y: 200 },
      },
      { id: outputId, kind: 'output', label: 'Reply', config: {}, position: { x: 760, y: 200 } },
    ],
    edges: [
      {
        id: createId('e'),
        source: { node_id: inputId, port: 'message' },
        target: { node_id: agentId, port: 'prompt' },
      },
      {
        id: createId('e'),
        source: { node_id: agentId, port: 'text' },
        target: { node_id: outputId, port: 'response' },
      },
    ],
  }
}

/** Kinds the graph may hold only one of. */
export const SINGLETON_KINDS: NodeKind[] = ['input', 'output']

/** Seeds a new node's config from its schema's `default` values. */
export function defaultConfigFor(spec: NodeKindSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(spec.config_schema.properties ?? {})) {
    if (property.default !== undefined) config[key] = structuredClone(property.default)
  }
  return config
}

export function createNode(spec: NodeKindSpec, position: { x: number; y: number }): WorkflowNode {
  return {
    id: createId('n'),
    kind: spec.kind,
    label: spec.label,
    config: defaultConfigFor(spec),
    position,
  }
}
