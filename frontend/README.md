# Workflow Studio — frontend

Build a graph of agents, tools and routers; save it; chat with it; and watch every
step the run took.

The app is **fully runnable with no backend**. Every endpoint is implemented by
MSW in the browser, seeded with two workflows, so `npm run dev` gives you a
working product on a clean checkout.

```bash
npm install
npm run dev          # http://localhost:5173
```

| Script                            |                                            |
| --------------------------------- | ------------------------------------------ |
| `npm run dev`                     | Dev server (mock API on by default)        |
| `npm run build`                   | Type-check and build for production        |
| `npm run typecheck`               | `tsc -b --force`                           |
| `npm test`                        | Unit tests — 79 of them, no browser needed |
| `npm run lint` / `npm run format` | oxlint / prettier                          |

---

## Screenshots

**Workflow list** — every workflow with its model, node count and the tools it uses.

![Workflow list](docs/screenshots/workflows.png)

**Chat** — the answer is the primary content; the steps that produced it sit underneath,
collapsed after the first turn. Node groups, edge transfers, tool calls with their JSON
input, the router's decision and the branch it pruned.

![Chat with the run timeline](docs/screenshots/chat.png)

**Builder** — typed ports, connections you can only draw where they are legal, and a
config form generated from the backend's own JSON Schema.

![Builder canvas](docs/screenshots/builder.png)

---

## The idea

A workflow is **data, not code**. Nodes declare typed input and output ports; edges
connect ports and carry values. The frontend renders node kinds, their port contracts
and their config forms from schemas the server publishes at `/api/node-kinds`, so
**adding a node kind on the backend needs no frontend change**.

Two consequences worth knowing about before reading the code:

- **`src/components/builder/NodeConfigForm.tsx` never mentions a node kind.** It renders
  whatever JSON Schema it is handed. The same component renders a node's config and a
  tool's arguments.
- **`src/components/builder/nodes/BaseNode.tsx` renders every kind on the canvas**, from
  the published spec. A kind the frontend has never heard of still draws with the right
  ports. (The plan sketched one component per kind; five identical files would have
  broken exactly the promise above.)

## The event envelope

Every observable thing in a run — node started, data crossed an edge, tool called,
router decided — is one `RunEvent` in an ordered log. `src/lib/events.ts` reduces that
array into what the UI draws.

That reducer is the load-bearing piece: **a live run and a replayed one go through it
together**, so a stored run cannot drift from a fresh one. It already handles
`partial`/`final` deltas, so when the backend adds SSE the only thing that changes is
what feeds it.

Sorting is by `seq`, never `ts` — timestamps tie.

## State boundary

Three stores, non-overlapping. Getting this wrong is the usual cause of "why is the
canvas out of sync".

| Store                                    | Owns                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| **TanStack Query**                       | Server truth: workflow list, a fetched workflow, node kinds, tools, providers, runs, emails |
| **Zustand** (`src/store/editorStore.ts`) | The unsaved draft in the builder, plus undo/redo                                            |
| **React `useState`**                     | Ephemeral UI: dialogs, composer text, which tab is open                                     |

Builder mount → Query fetches → `hydrate()` copies in **once** → all edits mutate
Zustand → Save sends `toInput()` → `markSaved()`. Nothing writes to the Query cache
from Zustand, and no query function reads Zustand.

## Layout

```
src/
├─ types/          api.ts · events.ts (RunEvent union) · ui.ts (frontend-only)
├─ lib/            client.ts · queries.ts · ports.ts · events.ts · jsonSchema.ts
│                  nodeVisuals.ts · nodeSummary.ts · richText.tsx · utils.ts
├─ store/          editorStore.ts
├─ hooks/          useChatSession · useDebouncedCommit · useEditorShortcuts · useMediaQuery
├─ mocks/          browser.ts · handlers.ts · fixtures.ts · db.ts · validate.ts
├─ pages/          WorkflowList · WorkflowEditor · Chat · Outbox · NotFound
└─ components/     ui/ (shadcn) · layout/ · common/ · workflow/ · builder/ · chat/
```

No business logic lives in components: port rules in `lib/ports.ts`, event reduction in
`lib/events.ts`, schema interpretation in `lib/jsonSchema.ts` — each independently
tested.

## The mock API

`VITE_USE_MOCKS=true` (the default in `.env`) serves the whole API from the browser.
Workflows persist in `localStorage` and chat transcripts in `sessionStorage`, so the
demo behaves like the real product across reloads. **Mock API → Reset demo data** in the
header puts the seed back.

Run fixtures are hand-authored with correct `seq` ordering, a real tool call and result,
one `edge.transfer` per traversed edge, a `route.decision` and a pruned `node.skipped`.
Failure paths are reachable by keyword, so a reviewer can hit them without editing code:

| Say this in chat | What happens                                      |
| ---------------- | ------------------------------------------------- |
| anything         | A normal run with a full timeline                 |
| `…fail…`         | A tool call errors and the agent recovers from it |
| `…refuse…`       | The run ends in `run.error` with code `refusal`   |
| `boom`           | HTTP 500                                          |
| `nokey`          | HTTP 401 `missing_api_key`                        |

## Connection rules

`lib/ports.ts` mirrors the backend rule — `any` connects to anything, identical types
connect, `text ↔ json` is rejected — and additionally refuses self-connections,
duplicate edges, and anything that would close a cycle. `POST /validate` remains the
authority; these rules exist to make a bad connection un-draggable.

**One deliberate relaxation.** Input ports are single-assignment, _except_ when the two
sources sit behind different output ports of the same router. A router activates exactly
one branch, so `input → router → {A | B} → output` — the seeded graph, and the plan's own
example — is legal and provably never delivers twice. See `areMutuallyExclusive`.

## Keyboard and accessibility

- **Chat**: Enter sends, Shift+Enter newlines.
- **Builder**: ⌘S/Ctrl+S saves, ⌘Z / ⇧⌘Z step history, Delete removes the selection.
  All stand down while a text field has focus.
- **The Outline tab is not a fallback.** Dragging on a canvas is unusable with a keyboard
  or a screen reader, so the same graph — nodes, connections, and a type-filtered
  two-dropdown connect form — is fully editable as a list. Both views read and write the
  same store.
- Icon-only buttons carry `aria-label`s; the run's pending state is an `aria-live`
  region; `prefers-reduced-motion` is honoured globally.
- Under 1024px the inspector becomes a sheet (selecting a node opens it); under 1280px
  the settings rail does the same.

## Testing

`npm test` — 79 unit tests, no browser:

- `lib/ports.test.ts` — type compatibility, cycles, occupancy, dynamic router ports
- `lib/events.test.ts` — the reducer, including streaming deltas, out-of-order input,
  unknown event types and partial logs
- `lib/jsonSchema.test.ts` — every supported field shape, plus `$ref` and `Optional[T]`
- `store/editorStore.test.ts` — `removeNode` edge cascade, connect rejection, undo/redo
- `mocks/handlers.test.ts` — the mock API end to end, including its failure fixtures

End-to-end tests are deliberately out of scope at this size; the UI was verified by
driving a real browser during development.

## Known limitations

- **`tool` nodes take literal arguments only.** The plan allows shipping v1 without
  per-argument _wired_ ports, and that is what this does: pick a tool, fill its arguments
  from its own `input_schema`. Wiring an argument to an incoming edge is a contained
  follow-up — `resolveInputs` in `lib/ports.ts` is where the extra ports would appear.
- **Autosave is intentionally absent.** Explicit save keeps the model simple and avoids
  persisting half-finished graphs. Leaving with unsaved changes is guarded.
- **The unsaved-changes guard does not use `useBlocker`.** That hook needs a data router,
  and the app uses react-router's declarative mode; instead every in-app exit routes
  through a confirm dialog and `beforeunload` covers closing the tab.
- **Single theme.** Dark mode is out of scope; the CSS variables are in place if it is
  ever wanted.

## Connecting the real backend

The FastAPI service does not exist yet. When it does:

1. Set `VITE_USE_MOCKS=false` in `.env`. The dev server already proxies `/api` to
   `http://localhost:8000`.
2. `npm run gen:api` writes `src/types/api.generated.ts` from the live `/openapi.json`.
   (`openapi-typescript` is not installed — it peers on TypeScript ^5 and this project is
   on 6; install it with `--legacy-peer-deps` or a newer release at that point.)
3. Delete `src/types/api.ts`, re-point imports, and fix the compile errors. **Those
   errors are the deliverable** — each one is a real disagreement between what the
   frontend assumed and what the backend serves. Resolve each by changing the frontend,
   or by filing the mismatch against the backend when the frontend's shape is right.
4. Check that flipping `VITE_USE_MOCKS` back to `true` still works. The mock layer is
   only ever imported dynamically, so deleting `src/mocks` breaks nothing else.
