import type { RunSummary, SentEmail, Usage, Workflow } from '@/types/api'
import type { RunEvent } from '@/types/events'
import { SEED_WORKFLOWS } from './fixtures'

/**
 * The mock backend's storage.
 *
 * It is backed by localStorage rather than a plain module variable so the demo
 * can honour the real product promise — "workflows persist and are editable" —
 * without a server. Clearing site data resets it to the seed.
 */

export interface StoredRun {
  run_id: string
  workflow_id: string
  user_message: string
  final_response: string
  events: RunEvent[]
  usage: Usage
  duration_ms: number
  created_at: string
}

interface Database {
  workflows: Workflow[]
  runs: StoredRun[]
  emails: SentEmail[]
}

const STORAGE_KEY = 'workflow-studio:mock-db:v1'

function seed(): Database {
  return {
    workflows: structuredClone(SEED_WORKFLOWS),
    runs: [],
    emails: [
      {
        id: 'em_seed_1',
        to: 'team@example.com',
        subject: 'Weekly research digest',
        body: 'Three sources on typed agent graphs, summarised.\n\n— sent by the Research assistant workflow.',
        run_id: 'run_seed',
        created_at: '2026-08-01T10:24:00.000Z',
      },
    ],
  }
}

const storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage

function load(): Database {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw) return seed()
    const parsed = JSON.parse(raw) as Partial<Database>
    return {
      workflows: parsed.workflows ?? [],
      runs: parsed.runs ?? [],
      emails: parsed.emails ?? [],
    }
  } catch {
    return seed()
  }
}

let db: Database = load()

function persist() {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(db))
  } catch {
    // Quota or private mode — the in-memory copy still works for this session.
  }
}

export const mockDb = {
  workflows: () => db.workflows,

  workflow: (id: string) => db.workflows.find((workflow) => workflow.id === id),

  insertWorkflow(workflow: Workflow) {
    db.workflows = [workflow, ...db.workflows]
    persist()
    return workflow
  },

  replaceWorkflow(workflow: Workflow) {
    db.workflows = db.workflows.map((existing) =>
      existing.id === workflow.id ? workflow : existing,
    )
    persist()
    return workflow
  },

  deleteWorkflow(id: string) {
    const before = db.workflows.length
    db.workflows = db.workflows.filter((workflow) => workflow.id !== id)
    db.runs = db.runs.filter((run) => run.workflow_id !== id)
    persist()
    return db.workflows.length < before
  },

  insertRun(run: StoredRun) {
    db.runs = [run, ...db.runs]
    persist()
    return run
  },

  run: (runId: string) => db.runs.find((run) => run.run_id === runId),

  runsFor(workflowId: string): RunSummary[] {
    return db.runs
      .filter((run) => run.workflow_id === workflowId)
      .map(({ run_id, user_message, final_response, created_at, usage, duration_ms }) => ({
        run_id,
        user_message,
        final_response,
        created_at,
        usage,
        duration_ms,
      }))
  },

  emails: () => db.emails,

  insertEmail(email: SentEmail) {
    db.emails = [email, ...db.emails]
    persist()
    return email
  },

  reset() {
    db = seed()
    persist()
  },
}
