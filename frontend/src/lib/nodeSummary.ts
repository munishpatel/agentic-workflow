import type { WorkflowNode } from '@/types/api'
import { pluralise, truncate } from '@/lib/utils'

/**
 * The one-line "what is this node set to" summary, shown on canvas nodes and in
 * the graph outline. Written against config *shape* rather than node kind so an
 * unfamiliar kind still says something useful.
 */
export function summariseNodeConfig(node: WorkflowNode): string | null {
  const config = node.config

  const toolId = config['tool_id']
  if (typeof toolId === 'string' && toolId) return toolId

  const routes = config['routes']
  if (Array.isArray(routes)) return pluralise(routes.length, 'route')

  const tools = config['tools']
  if (Array.isArray(tools)) {
    if (tools.length === 0) return 'No tools'
    return tools.filter((tool): tool is string => typeof tool === 'string').join(', ')
  }

  const instruction = config['instruction']
  if (typeof instruction === 'string' && instruction.trim()) return truncate(instruction, 60)

  return null
}
