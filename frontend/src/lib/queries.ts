import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  NodeKindSpec,
  ProviderMeta,
  RunRequest,
  RunResponse,
  RunSummary,
  SentEmail,
  ToolMeta,
  ValidationResult,
  Workflow,
  WorkflowInput,
  WorkflowSummary,
} from '@/types/api'
import { api } from '@/lib/client'

/**
 * Every server interaction in the app. Query keys are centralised here so
 * invalidation is a compile-checked reference rather than a hand-typed array
 * that silently stops matching.
 */
export const queryKeys = {
  workflows: ['workflows'] as const,
  workflow: (id: string) => ['workflows', id] as const,
  workflowRuns: (id: string) => ['workflows', id, 'runs'] as const,
  run: (runId: string) => ['runs', runId] as const,
  nodeKinds: ['node-kinds'] as const,
  tools: ['tools'] as const,
  providers: ['providers'] as const,
  emails: ['emails'] as const,
}

/* ── Schema discovery ────────────────────────────────────────────────────── */

// The registry changes only when the backend is redeployed, so these are
// effectively static for the life of a session.
const REGISTRY_OPTIONS = { staleTime: Infinity, gcTime: Infinity }

export function useNodeKinds() {
  return useQuery({
    queryKey: queryKeys.nodeKinds,
    queryFn: ({ signal }) => api.get<NodeKindSpec[]>('/node-kinds', signal),
    ...REGISTRY_OPTIONS,
  })
}

export function useTools() {
  return useQuery({
    queryKey: queryKeys.tools,
    queryFn: ({ signal }) => api.get<ToolMeta[]>('/tools', signal),
    ...REGISTRY_OPTIONS,
  })
}

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.get<ProviderMeta[]>('/providers', signal),
    ...REGISTRY_OPTIONS,
  })
}

/* ── Workflows ───────────────────────────────────────────────────────────── */

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: ({ signal }) => api.get<WorkflowSummary[]>('/workflows', signal),
  })
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.workflow(id ?? ''),
    queryFn: ({ signal }) => api.get<Workflow>(`/workflows/${id}`, signal),
    enabled: Boolean(id),
  })
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: WorkflowInput) => api.post<Workflow>('/workflows', input),
    onSuccess: (workflow) => {
      queryClient.setQueryData(queryKeys.workflow(workflow.id), workflow)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
  })
}

export function useUpdateWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WorkflowInput }) =>
      api.put<Workflow>(`/workflows/${id}`, input),
    onSuccess: (workflow) => {
      queryClient.setQueryData(queryKeys.workflow(workflow.id), workflow)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
  })
}

export function useDeleteWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/workflows/${id}`),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.workflow(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
  })
}

/**
 * Duplicating needs the full graph, and the list only carries summaries — so
 * this fetches the source first rather than making the caller do it.
 */
export function useDuplicateWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const source = await api.get<Workflow>(`/workflows/${id}`)
      const { name, description, provider, model, system_prompt, nodes, edges } = source
      return api.post<Workflow>('/workflows', {
        name: `${name} (copy)`,
        description,
        provider,
        model,
        system_prompt,
        nodes,
        edges,
      } satisfies WorkflowInput)
    },
    onSuccess: (workflow) => {
      queryClient.setQueryData(queryKeys.workflow(workflow.id), workflow)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
    },
  })
}

/**
 * The authority on graph correctness. It is a mutation rather than a query
 * because it takes the unsaved draft as its body — there is no stable cache key
 * for "the graph as it currently looks in the editor".
 */
export function useValidateWorkflow() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WorkflowInput }) =>
      api.post<ValidationResult>(`/workflows/${id}/validate`, input),
  })
}

/* ── Runs ────────────────────────────────────────────────────────────────── */

export function useRunWorkflow() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, request }: { id: string; request: RunRequest }) =>
      api.post<RunResponse>(`/workflows/${id}/run`, request),
    onSuccess: (run, { id }) => {
      queryClient.setQueryData(queryKeys.run(run.run_id), run)
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowRuns(id) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.emails })
    },
  })
}

export function useWorkflowRuns(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workflowRuns(id ?? ''),
    queryFn: ({ signal }) => api.get<RunSummary[]>(`/workflows/${id}/runs`, signal),
    enabled: Boolean(id) && enabled,
  })
}

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.run(runId ?? ''),
    queryFn: ({ signal }) => api.get<RunResponse>(`/runs/${runId}`, signal),
    enabled: Boolean(runId),
    // A finished run is immutable, so it never needs refetching.
    staleTime: Infinity,
  })
}

export function useEmails() {
  return useQuery({
    queryKey: queryKeys.emails,
    queryFn: ({ signal }) => api.get<SentEmail[]>('/emails', signal),
  })
}
