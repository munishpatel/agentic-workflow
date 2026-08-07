import type { NodeKind, NodeKindSpec, WorkflowInput, WorkflowNode } from '@/types/api'
import { createId } from '@/lib/utils'

export const FALLBACK_PROVIDER = 'anthropic'
export const FALLBACK_MODEL = 'claude-opus-5'

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Be accurate, be brief, and say plainly when you are unsure.'

/** What the "New workflow" dialog collects. */
export interface NewWorkflowValues {
  name: string
  description: string
  /** When true, the agent keeps its defaults and the fields below are ignored. */
  useDefaults: boolean
  systemPrompt: string
  toolsEnabled: boolean
  tools: string[]
}

/**
 * Dialog values → a create payload.
 *
 * This lives here, and not in the page, because more than one page offers
 * "New workflow" (the welcome screen and the list). Duplicating the mapping
 * meant one of them silently dropped the system prompt and tool selection —
 * and because the extra fields are optional, the compiler could not catch it.
 */
export function workflowInputFromDialog(
  values: NewWorkflowValues,
  provider?: { id: string; models: string[] },
): WorkflowInput {
  return newWorkflowInput({
    name: values.name.trim(),
    description: values.description,
    provider: provider?.id,
    model: provider?.models[0],
    // Ticking "use defaults" discards whatever was typed before it was ticked,
    // rather than half-applying a configuration the user opted out of.
    ...(values.useDefaults
      ? {}
      : {
          systemPrompt: values.systemPrompt,
          tools: values.toolsEnabled ? values.tools : [],
        }),
  })
}

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
  /** Blank or omitted keeps `DEFAULT_SYSTEM_PROMPT` — never an empty prompt. */
  systemPrompt?: string
  /** Tool ids the starting agent may call. */
  tools?: string[]
}): WorkflowInput {
  const inputId = createId('n')
  const agentId = createId('n')
  const outputId = createId('n')

  return {
    name: fields.name,
    description: fields.description.trim() || null,
    provider: fields.provider ?? FALLBACK_PROVIDER,
    model: fields.model ?? FALLBACK_MODEL,
    system_prompt: fields.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    nodes: [
      { id: inputId, kind: 'input', label: 'Start', config: {}, position: { x: 80, y: 200 } },
      {
        id: agentId,
        kind: 'agent',
        label: 'Agent',
        config: { instruction: '', tools: fields.tools ?? [], max_tool_iterations: 5 },
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
