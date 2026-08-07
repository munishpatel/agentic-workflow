import { create } from 'zustand'
import type {
  Edge,
  EdgeEnd,
  NodeKindSpec,
  Position,
  ValidationResult,
  Workflow,
  WorkflowInput,
  WorkflowNode,
} from '@/types/api'
import { canConnect, type ConnectVerdict } from '@/lib/ports'
import { createId } from '@/lib/utils'
import { createNode } from '@/lib/workflowDefaults'

/**
 * The unsaved draft of the workflow open in the builder — and nothing else.
 *
 * The boundary matters (frontend-plan.md §5): TanStack Query owns server truth,
 * this store owns edits in progress, `useState` owns ephemeral UI. The flow is
 * one-directional — Query fetches, `hydrate` copies in once, every edit mutates
 * here, Save sends `toInput()` back. Nothing writes to the Query cache from
 * here, and no query function reads from here.
 */

export interface EditorMeta {
  name: string
  description: string
  provider: string
  model: string
  system_prompt: string
}

interface Snapshot {
  meta: EditorMeta
  nodes: WorkflowNode[]
  edges: Edge[]
}

export interface EditorState {
  workflowId: string | null
  meta: EditorMeta
  nodes: WorkflowNode[]
  edges: Edge[]
  selectedNodeId: string | null
  isDirty: boolean
  validation: ValidationResult | null
  past: Snapshot[]
  future: Snapshot[]

  hydrate: (workflow: Workflow) => void
  markSaved: (workflow: Workflow) => void
  setMeta: <K extends keyof EditorMeta>(key: K, value: EditorMeta[K]) => void
  addNode: (spec: NodeKindSpec, position: Position) => string
  updateNodeConfig: (id: string, config: Record<string, unknown>) => void
  updateNodeLabel: (id: string, label: string) => void
  removeNode: (id: string) => void
  moveNode: (id: string, position: Position) => void
  connect: (source: EdgeEnd, target: EdgeEnd, specs: NodeKindSpec[]) => ConnectVerdict
  removeEdge: (id: string) => void
  select: (id: string | null) => void
  setValidation: (validation: ValidationResult | null) => void
  undo: () => void
  redo: () => void
  toInput: () => WorkflowInput
  reset: () => void
}

const HISTORY_LIMIT = 50

const EMPTY_META: EditorMeta = {
  name: '',
  description: '',
  provider: '',
  model: '',
  system_prompt: '',
}

function snapshot(state: EditorState): Snapshot {
  return { meta: state.meta, nodes: state.nodes, edges: state.edges }
}

/**
 * Every mutating action funnels through here, so "pushes undo history, clears
 * redo, marks dirty, invalidates the last validation result" can never be
 * forgotten in one action and remembered in another.
 */
function commit(
  state: EditorState,
): Pick<EditorState, 'past' | 'future' | 'isDirty' | 'validation'> {
  return {
    past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
    future: [],
    isDirty: true,
    // The graph changed, so the server's last verdict no longer describes it.
    validation: null,
  }
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  workflowId: null,
  meta: EMPTY_META,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isDirty: false,
  validation: null,
  past: [],
  future: [],

  hydrate: (workflow) =>
    set({
      workflowId: workflow.id,
      meta: {
        name: workflow.name,
        description: workflow.description ?? '',
        provider: workflow.provider,
        model: workflow.model,
        system_prompt: workflow.system_prompt,
      },
      nodes: structuredClone(workflow.nodes),
      edges: structuredClone(workflow.edges),
      selectedNodeId: null,
      isDirty: false,
      validation: null,
      past: [],
      future: [],
    }),

  markSaved: (workflow) =>
    set((state) => ({
      workflowId: workflow.id,
      isDirty: false,
      // Keep the user's current view; only the saved-ness changes. Positions and
      // ids came from this draft in the first place.
      meta: state.meta,
    })),

  setMeta: (key, value) =>
    set((state) => ({ ...commit(state), meta: { ...state.meta, [key]: value } })),

  addNode: (spec, position) => {
    const node = createNode(spec, position)
    set((state) => ({
      ...commit(state),
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
    }))
    return node.id
  },

  updateNodeConfig: (id, config) =>
    set((state) => ({
      ...commit(state),
      nodes: state.nodes.map((node) => (node.id === id ? { ...node, config } : node)),
    })),

  updateNodeLabel: (id, label) =>
    set((state) => ({
      ...commit(state),
      nodes: state.nodes.map((node) => (node.id === id ? { ...node, label } : node)),
    })),

  removeNode: (id) =>
    set((state) => ({
      ...commit(state),
      nodes: state.nodes.filter((node) => node.id !== id),
      // Every edge touching the node goes with it, or the graph keeps edges
      // pointing at something that no longer exists.
      edges: state.edges.filter((edge) => edge.source.node_id !== id && edge.target.node_id !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    })),

  moveNode: (id, position) =>
    set((state) => ({
      ...commit(state),
      nodes: state.nodes.map((node) => (node.id === id ? { ...node, position } : node)),
    })),

  connect: (source, target, specs) => {
    const { nodes, edges } = get()
    const verdict = canConnect({ nodes, edges, specs }, source, target)
    if (!verdict.ok) return verdict
    set((state) => ({
      ...commit(state),
      edges: [...state.edges, { id: createId('e'), source, target }],
    }))
    return verdict
  },

  removeEdge: (id) =>
    set((state) => ({
      ...commit(state),
      edges: state.edges.filter((edge) => edge.id !== id),
    })),

  select: (id) => set({ selectedNodeId: id }),

  setValidation: (validation) => set({ validation }),

  undo: () =>
    set((state) => {
      const previous = state.past.at(-1)
      if (!previous) return state
      return {
        ...previous,
        past: state.past.slice(0, -1),
        future: [snapshot(state), ...state.future].slice(0, HISTORY_LIMIT),
        isDirty: true,
        validation: null,
        selectedNodeId: previous.nodes.some((node) => node.id === state.selectedNodeId)
          ? state.selectedNodeId
          : null,
      }
    }),

  redo: () =>
    set((state) => {
      const next = state.future[0]
      if (!next) return state
      return {
        ...next,
        past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        isDirty: true,
        validation: null,
        selectedNodeId: next.nodes.some((node) => node.id === state.selectedNodeId)
          ? state.selectedNodeId
          : null,
      }
    }),

  toInput: () => {
    const { meta, nodes, edges } = get()
    return {
      name: meta.name.trim(),
      description: meta.description.trim() || null,
      provider: meta.provider,
      model: meta.model,
      system_prompt: meta.system_prompt,
      nodes,
      edges,
    }
  },

  reset: () =>
    set({
      workflowId: null,
      meta: EMPTY_META,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      isDirty: false,
      validation: null,
      past: [],
      future: [],
    }),
}))

/** The node the inspector is showing, or null. */
export function selectSelectedNode(state: EditorState): WorkflowNode | null {
  return state.nodes.find((node) => node.id === state.selectedNodeId) ?? null
}
