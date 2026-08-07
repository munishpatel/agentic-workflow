# Frontend Implementation Plan — Mini AI Workflow Builder

**This document is a self-contained handoff.** It assumes no prior conversation context. Everything needed to build the frontend — stack, API contract, file layout, conventions, build order, acceptance criteria — is here.

**The backend does not exist yet.** It is a Python FastAPI service, specified in `plan.md` at the repo root. The frontend is built against the contract in §3 of this document, served locally by MSW mocks, and switched to the real API in Phase 6. Read §3 carefully — it is the agreement between the two halves.

---

## 1. What we're building

A workflow builder + chat app. Users:

1. Create and name a workflow, set its system prompt, pick an LLM model.
2. Enable/disable tools and compose a **graph** of nodes on a canvas: an entry node, agent nodes (LLM + tools + instruction), deterministic tool nodes, a router node for branching, and an output node.
3. Save it. Workflows persist and are editable/reusable.
4. Chat with a saved workflow, seeing **tool calls, data moving between nodes, router decisions, and intermediate messages** before the final response.

The core design idea: **a workflow is data, not code.** Nodes declare typed input/output ports; edges connect ports and carry data. The frontend renders node kinds, their port contracts, and their config forms from server-published schemas — so adding a node kind on the backend requires **no frontend change**.

---

## 2. Stack

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite 6 + React 19 + TypeScript (strict) | |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` | v4 uses a Vite plugin and a CSS-first config, **not** `tailwind.config.js` + PostCSS |
| Components | shadcn/ui | Copy-in components, no runtime lock-in. Init with the Tailwind v4 target |
| Canvas | **`@xyflow/react`** (React Flow v12) | ⚠️ The package is `@xyflow/react`, not `reactflow` — v11 docs and most blog posts use the old name. Import CSS from `@xyflow/react/dist/style.css` |
| Server state | TanStack Query v5 | |
| Editor state | Zustand | Unsaved graph draft only — see the boundary rule in §5 |
| Forms | react-hook-form + a small JSON-Schema renderer | §6.3 |
| Routing | react-router v7 (declarative mode) | |
| API mocks | MSW v2 | Makes the frontend runnable and demoable with no backend |
| Types | Hand-written now → `openapi-typescript` generated in Phase 6 | §3.1 |
| Lint | ESLint + Prettier | |

```bash
npm create vite@latest . -- --template react-ts
npm i @xyflow/react @tanstack/react-query zustand react-router-dom react-hook-form clsx tailwind-merge lucide-react
npm i -D tailwindcss @tailwindcss/vite msw openapi-typescript prettier
npx shadcn@latest init
```

shadcn components to add: `button card input textarea label select checkbox dialog sheet tabs badge separator scroll-area skeleton sonner tooltip alert accordion dropdown-menu`.

---

## 3. The API contract

Base URL `/api`, proxied in dev to `http://localhost:8000` (see §4). All responses JSON. Field names are **`snake_case`** — the backend is Python and we do not transform casing at the boundary (one less place for bugs; the types below match the wire exactly).

### 3.1 Type source of truth

**Now:** hand-write these in `src/types/api.ts`, with a header comment:

```ts
// TEMPORARY: hand-authored mirror of the FastAPI contract.
// Phase 6 replaces this file with openapi-typescript output. Do not add
// frontend-only types here — those belong in src/types/ui.ts.
```

**Phase 6:** once the backend serves `/openapi.json`:

```json
"scripts": {
  "gen:api": "openapi-typescript http://localhost:8000/openapi.json -o src/types/api.generated.ts"
}
```

Then delete `src/types/api.ts`, re-point imports at the generated file, and fix the compile errors. **Those compile errors are the deliverable of that phase** — each one is a real contract drift between the hand-written assumption and the backend truth. Resolve each by changing the frontend, or by filing the mismatch against the backend if the frontend's shape is the correct one.

### 3.2 Core entities

```ts
type PortType = "text" | "json" | "number" | "boolean" | "any";

interface PortSpec {
  name: string;
  type: PortType;
  required: boolean;
  description: string;
}

type NodeKind = "input" | "agent" | "tool" | "router" | "output";

interface WorkflowNode {
  id: string;                  // stable; referenced by edges. Client-generated on create (nanoid)
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;   // shape defined by the kind's config_schema
  position: { x: number; y: number };
}

interface Edge {
  id: string;
  source: { node_id: string; port: string };
  target: { node_id: string; port: string };
}

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  provider: string;            // "anthropic"
  model: string;               // "claude-opus-5"
  system_prompt: string;       // graph-wide persona
  nodes: WorkflowNode[];
  edges: Edge[];
  created_at: string;          // ISO 8601
  updated_at: string;
}

// POST/PUT body — server owns id and timestamps
type WorkflowInput = Omit<Workflow, "id" | "created_at" | "updated_at">;
```

### 3.3 Schema discovery — how the builder stays generic

```ts
interface NodeKindSpec {
  kind: NodeKind;
  label: string;               // "Agent"
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[] | "dynamic";   // "dynamic" → derived from config, see below
  config_schema: JSONSchema7;        // JSON Schema (Pydantic model_json_schema output)
}

interface ToolMeta {
  id: string;                  // "calculator"
  name: string;
  description: string;
  input_schema: JSONSchema7;
}

interface ProviderMeta {
  id: string;                  // "anthropic"
  label: string;
  models: string[];
}
```

`GET /api/node-kinds` → `NodeKindSpec[]`
`GET /api/tools` → `ToolMeta[]`
`GET /api/providers` → `ProviderMeta[]`

**Dynamic outputs.** Only the `router` kind uses `outputs: "dynamic"`. Its config is `{ routes: { label: string; description: string }[] }`, and its output ports are **one `text` port per route, named after `route.label`**. Resolve this client-side in `src/lib/ports.ts`:

```ts
function resolveOutputs(spec: NodeKindSpec, node: WorkflowNode): PortSpec[]
// spec.outputs !== "dynamic"  → spec.outputs
// kind === "router"           → routes.map(r => ({ name: r.label, type: "text", required: false, description: r.description }))
```

`tool` node inputs are static in the spec (`{ tool_id }` config selects which tool; the node exposes a single `args: json` input plus the tool's own fields are configured, not wired, in v1 — see §6.4).

### 3.4 Workflow endpoints

| Method | Path | Body | → |
|---|---|---|---|
| `GET` | `/api/workflows` | — | `WorkflowSummary[]` |
| `POST` | `/api/workflows` | `WorkflowInput` | `Workflow` |
| `GET` | `/api/workflows/{id}` | — | `Workflow` |
| `PUT` | `/api/workflows/{id}` | `WorkflowInput` | `Workflow` |
| `DELETE` | `/api/workflows/{id}` | — | `204` |
| `POST` | `/api/workflows/{id}/validate` | `WorkflowInput` | `ValidationResult` |

```ts
interface WorkflowSummary {
  id: string; name: string; description: string | null;
  model: string; node_count: number; tool_ids: string[];
  updated_at: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
interface ValidationIssue {
  code: string;                // "missing_output_node" | "cycle_detected" | "port_type_mismatch" | "starved_input" | ...
  message: string;
  node_id?: string;
  edge_id?: string;
}
```

`/validate` is the **authority** on graph correctness. The client's own port-compatibility check (§6.5) exists purely to make bad connections un-draggable — it is a UX affordance, not a second source of truth. If they ever disagree, the server wins and the client rule is the bug.

### 3.5 Running a workflow

```ts
// POST /api/workflows/{id}/run
interface RunRequest {
  message: string;
  history: ChatTurn[];              // prior turns, oldest first
}
interface ChatTurn { role: "user" | "assistant"; content: string }

interface RunResponse {
  run_id: string;
  final_response: string;
  events: RunEvent[];
  usage: { input_tokens: number; output_tokens: number };
  duration_ms: number;
}
```

`GET /api/workflows/{id}/runs` → `RunSummary[]` (`{ run_id, user_message, final_response, created_at, usage, duration_ms }`), plus `GET /api/runs/{run_id}` → `RunResponse` for replaying an old run's timeline.

`GET /api/emails` → `SentEmail[]` (`{ id, to, subject, body, run_id, created_at }`) — the mock outbox, proving the email tool did something.

### 3.6 The event envelope — the most important type

Every observable thing in a run is one `RunEvent`. There is deliberately no per-concern event type; this is what makes streaming an additive change later.

```ts
interface RunEvent {
  id: string;
  run_id: string;
  seq: number;                 // monotonic total order within a run — sort by this, never by ts
  ts: number;                  // epoch seconds, float
  author: "user" | "system" | "node";
  node_id?: string;            // absent on run-level events
  branch?: string;             // sub-workflow nesting path; absent in v1
  type: RunEventType;
  payload: Record<string, unknown>;
  partial: boolean;            // true = this is a delta, more coming
  final: boolean;              // true = last event for this (node_id, type) group
}

type RunEventType =
  | "run.start" | "run.end" | "run.error"
  | "node.start" | "node.end" | "node.skipped"
  | "edge.transfer"
  | "llm.request" | "llm.response"
  | "text.delta" | "text.message"
  | "tool.call" | "tool.result"
  | "route.decision";
```

Payloads by type (narrow these with a discriminated union in `src/types/events.ts`):

| type | payload |
|---|---|
| `run.start` | `{ workflow_id, workflow_name }` |
| `run.end` | `{ final_response, usage, duration_ms }` |
| `run.error` | `{ code, message, node_id? }` |
| `node.start` / `node.end` | `{ kind, label }` (`node.end` adds `{ ms }`) |
| `node.skipped` | `{ kind, label, reason }` — a pruned router branch |
| `edge.transfer` | `{ source: {node_id, port}, target: {node_id, port}, port_type, preview }` — `preview` is a truncated string form of the value |
| `llm.response` | `{ iteration, usage, stop_reason }` |
| `text.delta` | `{ text }` with `partial: true` |
| `text.message` | `{ text }` with `final: true` |
| `tool.call` | `{ call_id, tool, input }` |
| `tool.result` | `{ call_id, tool, output, is_error, ms }` |
| `route.decision` | `{ chosen, reason, considered: string[] }` |

**Build the client as a reducer over this array.** `reduceEvents(events) → TimelineView`. Non-negotiable, for two reasons: (a) replaying a stored run and consuming a live SSE stream go through the *same* function, so replay cannot drift from live; (b) when the backend adds streaming (`?stream=1`, same envelopes over SSE), the only change is the transport that feeds the reducer.

Handle `partial`/`final` from day one even though v1 only ever sends `final: true` — accumulate `text.delta` payloads into the pending message for the same `node_id`, and treat a subsequent `text.message` as the authoritative replacement.

### 3.7 Errors

Every non-2xx has one shape:

```ts
interface ApiError { error: { code: string; message: string; details?: unknown } }
```

Codes to handle explicitly with a tailored message: `missing_api_key` (backend has no LLM credential — tell the user to set it in `backend/.env`), `refusal` (the model declined), `rate_limit` (offer retry), `iteration_limit` / `node_limit` (the workflow looped), `validation_error`. Everything else: show `message` in a toast.

---

## 4. Project config

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
});
```

`src/index.css` (Tailwind v4 — CSS-first, no `tailwind.config.js`):

```css
@import "tailwindcss";
@import "@xyflow/react/dist/style.css";
/* shadcn init writes its @theme / CSS variable block here */
```

`.env.example`:
```
# Leave empty to use the Vite dev proxy (recommended for local dev)
VITE_API_BASE_URL=
# Set to "true" to serve the API from MSW mocks instead of the backend
VITE_USE_MOCKS=true
```

`tsconfig`: `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`.

---

## 5. State boundary — read this before writing any state code

Three stores, non-overlapping. Violating this is the most likely source of "why is the canvas out of sync" bugs.

| Store | Owns | Never holds |
|---|---|---|
| **TanStack Query** | Server truth: workflow list, a fetched workflow, node-kinds, tools, providers, runs, emails | Anything the user is mid-edit on |
| **Zustand** (`useEditorStore`) | The **unsaved draft** of the workflow currently open in the builder: `nodes`, `edges`, `selectedNodeId`, `isDirty`, undo/redo stacks, transient validation results | Anything fetched that isn't being edited; any chat state |
| **React local** (`useState`) | Ephemeral UI: dialog open, chat composer text, accordion expansion | Anything that survives unmount |

Flow: builder mount → Query fetches `Workflow` → `hydrate(workflow)` copies it into Zustand once → all edits mutate Zustand → Save runs a Query mutation with the draft → on success, invalidate the workflow query and `markSaved()`. **Never** write to the Query cache from Zustand or read Zustand inside a query function.

`useEditorStore` shape:

```ts
interface EditorStore {
  workflowId: string | null;
  meta: { name: string; description: string; provider: string; model: string; system_prompt: string };
  nodes: WorkflowNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  isDirty: boolean;
  validation: ValidationResult | null;
  past: Snapshot[]; future: Snapshot[];   // undo/redo, cap at 50

  hydrate(w: Workflow): void;
  markSaved(w: Workflow): void;
  setMeta<K extends keyof Meta>(k: K, v: Meta[K]): void;
  addNode(kind: NodeKind, position: XYPosition): void;
  updateNodeConfig(id: string, config: Record<string, unknown>): void;
  updateNodeLabel(id: string, label: string): void;
  removeNode(id: string): void;          // must also drop every edge touching it
  moveNode(id: string, position: XYPosition): void;
  connect(source: EdgeEnd, target: EdgeEnd): void;   // reject if incompatible or target port occupied
  removeEdge(id: string): void;
  select(id: string | null): void;
  undo(): void; redo(): void;
  toInput(): WorkflowInput;
}
```

Every mutating action sets `isDirty` and pushes a snapshot. `removeNode` cascading to edges is the classic bug — write a test for it.

---

## 6. Screens and components

### 6.1 `/` — Workflow list

Grid of cards from `GET /api/workflows`: name, description, model badge, node count, tool badges. Actions per card: **Chat** (primary), **Edit**, **Duplicate**, **Delete** (confirm dialog). Header: "New workflow" → dialog for name + description → `POST` a minimal valid graph (an `input` node wired to an `output` node, positioned sensibly) → navigate to the builder. Empty state explains what a workflow is and offers the same CTA. Loading: skeleton cards. Error: inline retry.

### 6.2 `/workflows/:id/edit` — Builder

Three regions:

**Left rail (fixed, ~240px)** — workflow meta: name, description, provider select, model select (options from the chosen provider's `models`), system prompt textarea. Below it, a **node palette**: one button per `NodeKindSpec` with label + description tooltip, disabled for kinds already at their cap (`input` and `output` are singletons). Click or drag to add.

**Canvas (flex-1)** — `@xyflow/react`. See §6.5.

**Right panel (~360px, `Sheet` on narrow viewports)** — inspector for `selectedNodeId`: editable label, then the config form generated from that kind's `config_schema` (§6.3). Shows the node's resolved input and output ports with their types. Empty state when nothing is selected: a short "select a node" hint plus the current validation issues.

**Top bar** — breadcrumb, dirty indicator, **Validate** button, **Save** (disabled unless `isDirty`; shows a spinner during mutation), **Chat** (warns on unsaved changes). Validation results render as a dismissible banner listing issues; clicking an issue with a `node_id` selects and centres that node.

Autosave is deliberately **not** implemented — explicit save keeps the mental model simple and avoids saving invalid intermediate graphs. Guard navigation away while `isDirty` with a confirm dialog.

### 6.3 Schema-driven config forms — `NodeConfigForm`

This component is what makes "adding a node kind needs no frontend change" true. It renders a form from a `JSONSchema7` object. Support exactly these field shapes and no more:

| JSON Schema | Control |
|---|---|
| `type: "string"` | `Input` |
| `type: "string"` with a long description or `x-ui: "textarea"`, or property name matching `/instruction\|prompt\|body/` | `Textarea` (min 6 rows) |
| `type: "string"` with `enum` | `Select` |
| `type: "integer"`/`"number"` | numeric `Input`, honour `minimum`/`maximum` |
| `type: "boolean"` | `Checkbox` |
| `type: "array"`, `items.type: "string"` with `enum` | multi-select checkbox list |
| `type: "array"`, `items.type: "string"` no enum | editable string list (add/remove rows) |
| `type: "array"`, `items.type: "object"` | repeatable sub-form (this is `router.routes`) |
| anything else | raw JSON `Textarea` with parse validation — a visible, honest fallback rather than a silent drop |

Use `required`, `description` (as help text), `title` (as label, falling back to a humanised property name), and `default`. Wire it with react-hook-form; validate on blur; write valid values through to `updateNodeConfig` (debounced ~300ms).

**One special case worth hardcoding:** the `agent` kind's `tools` property is `array<string>` with an enum of tool ids. Render it with `ToolPicker` instead of a bare checkbox list, so each tool shows its `name` and `description` from `GET /api/tools`. This is the "enable or disable tools" requirement from the brief and deserves better than a list of raw ids. Detect it by property name `tools` + array-of-enum-string, not by node kind, so a future node kind with a `tools` field gets it for free.

### 6.4 `tool` node config (v1 simplification)

The `tool` node calls one registry tool deterministically. Its config is `{ tool_id: string, args: Record<string, unknown> }`: `tool_id` is a select over `GET /api/tools`, and once chosen, the `args` sub-form is rendered from **that tool's `input_schema`** using the same `NodeConfigForm` renderer. Each arg field gets a toggle: *literal value* (typed in the form) or *wired* (supplied by an incoming edge). Wired args become input ports on the node.

If that toggle proves fiddly, **ship literal-only for v1** and note it in the README. Literal-only still demonstrates the deterministic-tool-node concept, and the port-wiring version is a contained follow-up.

### 6.5 Canvas — `@xyflow/react` specifics

Controlled component: `nodes` and `edges` derive from Zustand, never React Flow's internal state.

```tsx
<ReactFlow
  nodes={rfNodes} edges={rfEdges}
  nodeTypes={NODE_TYPES}                 // module-level const — inline object remounts every render
  onNodesChange={handleNodesChange}      // persist only `position` changes on dragEnd
  onEdgesChange={handleEdgesChange}
  onConnect={handleConnect}
  isValidConnection={isValidConnection}
  onNodeClick={(_, n) => select(n.id)}
  onPaneClick={() => select(null)}
  fitView
>
  <Background /> <Controls /> <MiniMap />
</ReactFlow>
```

Rules that will bite if ignored:

- The container needs an **explicit height** (`h-full` on a parent chain that resolves to a real pixel height), or the canvas renders 0px tall.
- `nodeTypes` must be a module-level constant. Defining it inline remounts every node on every render.
- **Handle `id` = port name.** One `<Handle type="target" id={port.name} position={Position.Left}>` per input port, one `type="source"` per output port, vertically distributed and labelled. This is what makes edges port-to-port rather than node-to-node.
- `isValidConnection` calls `arePortsCompatible(sourcePortType, targetPortType)` from `src/lib/ports.ts` — the mirror of the backend rule: `any` connects to anything; identical types connect; `text ↔ json` is rejected. **Also reject** a target input port that already has an edge (inputs are single-assignment) and any connection that would create a cycle (DFS over the draft edges — `hasPath(target, source)`).
- Custom node component per kind, sharing one `BaseNode` shell: coloured left border by kind, kind icon, label, config summary line (e.g. an agent's tool count, a router's route count), and a red ring when it has a validation error. Selected state from `selectedNodeId`, not React Flow's `selected`.
- Persist positions on drag **end** only (`onNodeDragStop`), not on every `position` change, or undo history fills with sub-pixel noise.

### 6.6 `/workflows/:id/chat` — Chat

Header: workflow name, a picker to switch workflows without leaving the page, an "Edit" link, and cumulative token/duration for the session. Body: message list. Composer: textarea + send, Enter to send / Shift+Enter for newline, disabled while a run is in flight.

Each assistant turn renders:

1. **The final response** as the primary content — largest, first, unmissable. The intermediate steps must never bury the answer.
2. Below it, a collapsible **`Timeline`** ("7 steps · 2 tool calls · 1.8s"), collapsed by default after the first turn, expanded by default on the very first turn of a session so the feature is discovered.

`Timeline` renders `reduceEvents(events)`:

- **Node group** per `node.start`/`node.end` pair: kind icon, label, duration. `node.skipped` renders dimmed with its reason ("router chose `needs_research`").
- **`edge.transfer`** as a small chip between node groups: `Research ─ text ─▶ Draft` with the `preview` in a tooltip. This is the visible payoff of the typed-connection model — do not omit it.
- **`tool.call`** → tool name + pretty-printed JSON input in a collapsible `<pre>`.
- **`tool.result`** → output (truncated past ~600 chars with expand), duration, red styling when `is_error`.
- **`route.decision`** → `chosen` as a badge plus `reason` as prose, with the not-taken options listed dimmed.
- **`llm.response`** → a compact per-iteration token count.
- **`run.error`** → an alert with the code and message.

While a run is in flight, show a live pending state (spinner + "Running…"). Since v1 is non-streaming, this is a single indeterminate state; the reducer already handles `partial` events, so when SSE lands the same component animates without modification.

Persist chat turns per workflow in `sessionStorage` keyed by workflow id, so a refresh doesn't lose the conversation. Send prior turns as `RunRequest.history`. Offer "Load past runs" from `GET /api/workflows/{id}/runs`, which fetches a stored run and renders its timeline through the identical reducer — the proof that replay and live share a path.

---

## 7. MSW mocks — why they're mandatory, not optional

The frontend must be independently runnable and demoable. `src/mocks/handlers.ts` implements every endpoint in §3 against an in-memory store seeded with two workflows:

1. **"Research assistant"** — `input → router → { search_agent | direct_agent } → output`. Exercises branching, pruning, and multi-node timelines.
2. **"Math helper"** — `input → agent(calculator) → output`. The minimal case.

The `run` handler returns a **hand-authored, realistic `RunEvent[]`** with correct `seq` ordering, a plausible tool call and result, an `edge.transfer` per traversed edge, a `route.decision`, and a `node.skipped` for the pruned branch, with a ~900ms artificial delay. Building the Timeline against this fixture is faster and more thorough than waiting on the backend, and it doubles as the fixture for reducer unit tests.

Gate on `VITE_USE_MOCKS`; start the worker in `main.tsx` before render. Also author deliberate failure fixtures (a `run.error` with `code: "refusal"`, a `tool.result` with `is_error: true`, a 500, a validation failure) — error paths are otherwise the last thing built and the first thing a reviewer hits.

---

## 8. File layout

```
frontend/
├─ .env.example · vite.config.ts · tsconfig.json · components.json
├─ public/mockServiceWorker.js          # msw init writes this
└─ src/
   ├─ main.tsx                          # QueryClientProvider, RouterProvider, MSW bootstrap, Toaster
   ├─ App.tsx                           # routes + AppShell
   ├─ index.css
   ├─ types/
   │  ├─ api.ts                         # §3 contract — replaced by api.generated.ts in Phase 6
   │  ├─ events.ts                      # RunEvent discriminated union by `type`
   │  └─ ui.ts                          # frontend-only types (TimelineView, EditorStore, …)
   ├─ lib/
   │  ├─ client.ts                      # fetch wrapper: base URL, JSON, ApiError parsing
   │  ├─ queries.ts                     # query keys + hooks (useWorkflows, useNodeKinds, useRunWorkflow, …)
   │  ├─ ports.ts                       # resolveOutputs, arePortsCompatible, hasPath (cycle check)
   │  ├─ events.ts                      # reduceEvents(events) → TimelineView
   │  ├─ jsonSchema.ts                  # JSONSchema7 → field descriptors for NodeConfigForm
   │  └─ utils.ts                       # cn(), truncate(), formatMs(), humanise()
   ├─ store/editorStore.ts              # Zustand
   ├─ mocks/{browser.ts,handlers.ts,fixtures.ts}
   ├─ pages/{WorkflowListPage,WorkflowEditorPage,ChatPage}.tsx
   └─ components/
      ├─ ui/                            # shadcn generated — do not hand-edit
      ├─ layout/{AppShell,TopBar}.tsx
      ├─ workflow/{WorkflowCard,NewWorkflowDialog,WorkflowMetaForm}.tsx
      ├─ builder/{GraphCanvas,NodePalette,NodeInspector,NodeConfigForm,ToolPicker,
      │            ValidationBanner,nodes/{BaseNode,InputNode,AgentNode,ToolNode,RouterNode,OutputNode}.tsx}
      └─ chat/{MessageList,MessageBubble,Composer,Timeline,TimelineNodeGroup,
                EdgeTransferChip,ToolCallCard,RouteDecisionCard}.tsx
```

---

## 9. Build order

Each phase ends in something demoable. Do not start a phase before the previous one runs.

**Phase 0 — Scaffold.** Vite + TS strict, Tailwind v4 via the Vite plugin, shadcn init, path alias, ESLint/Prettier, `AppShell` + three empty routes, dev proxy. Verify: `npm run dev` renders a styled shell with working navigation.

**Phase 1 — Contract and mocks.** `types/api.ts`, `types/events.ts`, `lib/client.ts`, MSW handlers + fixtures including the hand-authored `RunEvent[]`. Verify: `curl`-equivalent via the browser console returns mocked workflows.

**Phase 2 — Workflow list.** TanStack Query setup, query keys, `useWorkflows`, cards, new-workflow dialog, delete confirm, duplicate, skeletons, empty and error states. Verify: full CRUD against mocks, no console warnings.

**Phase 3 — Chat (before the canvas — deliberately).** `reduceEvents` with unit tests over the fixture, then `Timeline` and its sub-cards, then `MessageList` + `Composer`, then wire `useRunWorkflow`. Verify: send a message, see the final answer with a correct expandable timeline showing node groups, an edge transfer, a tool call/result, and a route decision.

> Chat comes before the canvas on purpose. It is the part a reviewer judges first and the part that proves the event-envelope design. The canvas is the biggest time sink in this project — if anything gets cut, it must not be the thing that demonstrates the system works end to end.

**Phase 4 — Builder, non-canvas parts.** Zustand store with unit tests (`removeNode` cascade, connect rejection, undo/redo), `WorkflowMetaForm`, `lib/jsonSchema.ts` + `NodeConfigForm`, `ToolPicker`, `NodeInspector`, `NodePalette`, save mutation, dirty guard, `ValidationBanner`. Verify: add nodes, edit configs, save, reload, and see it persist — with a temporary plain node list standing in for the canvas.

**Phase 5 — Canvas.** `GraphCanvas`, custom nodes with per-port handles, `isValidConnection` with type + occupancy + cycle checks, selection sync, position persistence on drag end, `Background`/`Controls`/`MiniMap`. Verify: build the Research-assistant graph from scratch by dragging, save it, reload it, and confirm invalid connections cannot be drawn.

**Phase 6 — Real backend.** Point the proxy at the live FastAPI service, add `gen:api`, generate `api.generated.ts`, delete `api.ts`, resolve every compile error as a genuine contract question. Set `VITE_USE_MOCKS=false`. Verify: a real LLM run with real tool calls renders correctly, and the mocked path still works when the flag is flipped back.

**Phase 7 — Polish.** Loading and error states on every surface, keyboard support (Enter/Shift+Enter, Delete removes selection, Cmd+Z/Cmd+Shift+Z, Cmd+S saves), responsive behaviour (inspector becomes a `Sheet` under ~1024px), focus-visible rings, `aria-label`s on icon-only buttons, `prefers-reduced-motion`, a mock-outbox view for `GET /api/emails`, and a README section with screenshots.

---

## 10. Conventions

- **`snake_case` at the boundary, unchanged.** Contract types keep the wire shape; only frontend-only types in `types/ui.ts` use `camelCase`. No transform layer.
- **Sort events by `seq`, never `ts`.** Timestamps can tie.
- **No `any`.** Unknown payloads are `unknown` and narrowed. `JSONSchema7` comes from `json-schema` types or a local minimal interface.
- **Query keys centralised** in `lib/queries.ts` as a `queryKeys` object. No inline array literals at call sites.
- **Mutations invalidate explicitly.** No blanket `invalidateQueries()`.
- **Every list has an empty state, a loading skeleton, and an error state.** No exceptions — this is the most common source of "feels unfinished".
- **No business logic in components.** Port rules live in `lib/ports.ts`, event reduction in `lib/events.ts`, schema interpretation in `lib/jsonSchema.ts`, all independently testable.
- **Commit per phase**, with a message naming the phase.

## 11. Definition of done

- [ ] Create, name, edit, save, duplicate and delete workflows; they persist across reload.
- [ ] Set a system prompt and enable/disable tools per agent node.
- [ ] Compose a graph on the canvas with typed port-to-port connections; type-incompatible, duplicate-target and cycle-forming connections are impossible to draw.
- [ ] `/validate` errors surface inline and clicking one focuses the offending node.
- [ ] Pick a saved workflow, chat with it, and see tool calls, edge transfers, router decisions and intermediate messages, with the final response as the primary content.
- [ ] Past runs replay their timeline through the same reducer as live runs.
- [ ] Every screen has loading, empty and error states; `missing_api_key`, `refusal` and `rate_limit` all produce a comprehensible message.
- [ ] `npm run build` and `tsc --noEmit` are clean with strict mode on.
- [ ] The app runs with `VITE_USE_MOCKS=true` and no backend.

## 12. Explicitly out of scope

Auth, multi-user, dark-mode toggle (ship one good theme), i18n, virtualised message lists, workflow templates gallery, node search/filter on the canvas, real-time collaboration, e2e tests (unit tests for `lib/` and the store are enough at this size).
