import type { ValidationIssue, ValidationResult, WorkflowInput } from '@/types/api'
import { arePortsCompatible, hasPath, resolvePorts } from '@/lib/ports'
import { NODE_KINDS } from './fixtures'

/**
 * A stand-in for the backend's `POST /validate`.
 *
 * The real one is the authority; this mirrors the checks named in the contract
 * (`missing_output_node`, `cycle_detected`, `port_type_mismatch`,
 * `starved_input`) closely enough that the builder's error surface is exercised
 * for real while the backend is being written.
 */
export function validateWorkflow(input: WorkflowInput): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const { nodes, edges } = input

  const inputNodes = nodes.filter((node) => node.kind === 'input')
  const outputNodes = nodes.filter((node) => node.kind === 'output')

  if (inputNodes.length === 0) {
    errors.push({ code: 'missing_input_node', message: 'The workflow needs an input node.' })
  }
  if (inputNodes.length > 1) {
    for (const node of inputNodes.slice(1)) {
      errors.push({
        code: 'duplicate_input_node',
        message: 'Only one input node is allowed.',
        node_id: node.id,
      })
    }
  }
  if (outputNodes.length === 0) {
    errors.push({
      code: 'missing_output_node',
      message: 'The workflow needs an output node — without one there is nothing to reply with.',
    })
  }
  if (outputNodes.length > 1) {
    for (const node of outputNodes.slice(1)) {
      errors.push({
        code: 'duplicate_output_node',
        message: 'Only one output node is allowed.',
        node_id: node.id,
      })
    }
  }

  for (const edge of edges) {
    const sourceNode = nodes.find((node) => node.id === edge.source.node_id)
    const targetNode = nodes.find((node) => node.id === edge.target.node_id)
    if (!sourceNode || !targetNode) {
      errors.push({
        code: 'dangling_edge',
        message: 'This connection points at a node that no longer exists.',
        edge_id: edge.id,
      })
      continue
    }
    const sourcePort = resolvePorts(NODE_KINDS, sourceNode).outputs.find(
      (port) => port.name === edge.source.port,
    )
    const targetPort = resolvePorts(NODE_KINDS, targetNode).inputs.find(
      (port) => port.name === edge.target.port,
    )
    if (!sourcePort || !targetPort) {
      errors.push({
        code: 'unknown_port',
        message: `“${edge.source.port} → ${edge.target.port}” refers to a port that does not exist.`,
        edge_id: edge.id,
      })
      continue
    }
    if (!arePortsCompatible(sourcePort.type, targetPort.type)) {
      errors.push({
        code: 'port_type_mismatch',
        message: `${sourceNode.label}.${sourcePort.name} is ${sourcePort.type} but ${targetNode.label}.${targetPort.name} expects ${targetPort.type}.`,
        edge_id: edge.id,
        node_id: targetNode.id,
      })
    }
  }

  for (const node of nodes) {
    const { inputs, outputs } = resolvePorts(NODE_KINDS, node)

    for (const port of inputs) {
      if (!port.required) continue
      const fed = edges.some(
        (edge) => edge.target.node_id === node.id && edge.target.port === port.name,
      )
      if (!fed) {
        errors.push({
          code: 'starved_input',
          message: `${node.label} needs something connected to its “${port.name}” input.`,
          node_id: node.id,
        })
      }
    }

    if (node.kind !== 'output' && outputs.length > 0) {
      const used = edges.some((edge) => edge.source.node_id === node.id)
      if (!used) {
        warnings.push({
          code: 'dangling_output',
          message: `${node.label} produces a value that nothing consumes.`,
          node_id: node.id,
        })
      }
    }

    if (node.kind === 'router' && outputs.length < 2) {
      errors.push({
        code: 'router_needs_routes',
        message: `${node.label} needs at least two routes to be worth branching on.`,
        node_id: node.id,
      })
    }

    if (node.kind === 'agent' && !String(node.config['instruction'] ?? '').trim()) {
      warnings.push({
        code: 'empty_instruction',
        message: `${node.label} has no instruction — it will fall back to the workflow system prompt alone.`,
        node_id: node.id,
      })
    }

    if (node.kind === 'tool' && !node.config['tool_id']) {
      errors.push({
        code: 'tool_not_selected',
        message: `${node.label} has no tool selected.`,
        node_id: node.id,
      })
    }

    if (node.kind !== 'input') {
      const reachable = inputNodes.some((entry) => hasPath(edges, entry.id, node.id))
      if (!reachable) {
        warnings.push({
          code: 'unreachable_node',
          message: `${node.label} cannot be reached from the input node, so it will never run.`,
          node_id: node.id,
        })
      }
    }
  }

  for (const node of nodes) {
    const loops = edges.some(
      (edge) => edge.target.node_id === node.id && hasPath(edges, node.id, edge.source.node_id),
    )
    if (loops) {
      errors.push({
        code: 'cycle_detected',
        message: `${node.label} takes part in a cycle. Workflows must be acyclic.`,
        node_id: node.id,
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
