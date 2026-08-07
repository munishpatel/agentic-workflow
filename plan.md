# Mini AI Workflow Builder — Implementation Plan

A web app where users configure AI workflows (system prompt + tools + a step/decision flow), save them to a database, and chat with them. The deliverable is a **working end-to-end configurable system**. Bonus features are out of scope for v1, but the core abstractions are chosen so they land as additions rather than rewrites.

---

## 0. Two guiding constraints

### 0.1 The orchestration is ours

**No vendor agent SDK.** Not `anthropic`, not LangChain / LlamaIndex / LangGraph — nothing that owns the agent loop. The LLM is reached over **raw HTTPS with `httpx`**, behind a provider-adapter protocol we define. The tool-use loop, tool registry and dispatch, graph scheduler, routing, event emission, retries and token accounting are all code we write, read and test.

What this buys: we understand the tool-use wire protocol rather than a helper's API; provider swaps are an adapter; control flow is explicit and unit-testable; nothing is coupled to a beta helper. The only dependency near the model is `httpx`.

### 0.2 Borrowed mental models, not borrowed code

Three pieces of prior art shape the design. We take the *model*, write the implementation ourselves, and credit them in the README.

| Source | Idea borrowed | Where it lands here |
|---|---|---|
| **SmythOS** | Typed component I/O; **the connection carries the data**, not just control | §2 node graph: nodes declare typed input/output ports; edges are data channels validated at edit time *and* runtime. Kills the "everything is one blob of conversation state" failure mode |
| **Google ADK** | Event-based streaming with a uniform event envelope | §5 one `RunEvent` shape for everything, with `partial` / `final` flags so SSE streaming later needs no new event types |
| **Google ADK** | Agent as a composable unit | §2/§6 an agent is just a node with a port contract, so a `subworkflow` node invoking another saved workflow is a drop-in — same scheduler, same envelopes |

Sanity check applied throughout: if a decision here can't be justified against one of those models or against the brief, it's scope creep.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Backend | **Python 3.13 + FastAPI + Uvicorn** | Async-native (real parallelism for independent branches and parallel tool calls), auto OpenAPI docs at `/docs` for free |
| Models / validation | **Pydantic v2** | One source of truth for the HTTP boundary, node port types, node config, **and** tool input schemas |
| ORM / DB | **SQLModel + SQLite** (`aiosqlite`) | SQLModel = SQLAlchemy 2.0 + Pydantic, so DB models and API models share definitions. One URL change to Postgres (`asyncpg`) |
| LLM transport | **`httpx.AsyncClient`** → provider REST API | Our loop, our code |
| Tests | **pytest + pytest-asyncio + respx** | `respx` mocks the provider at the HTTP layer, so the engine is testable with no API key and no vendor test double |
| Frontend | React 19 + Vite + TypeScript + Tailwind | Fast loop, no SSR complexity |

Two projects: `backend/` and `frontend/` (both directories exist, empty).

**Pydantic earns its place twice.** `Model.model_json_schema()` emits JSON Schema directly, so a tool's Pydantic input model *is* its model-facing schema, its runtime validator, and its graph-node port contract — no schema converter, no duplication, one definition. Same for node config forms, which the frontend renders from the server-published schema.

**Default provider: Anthropic Messages API** (`POST https://api.anthropic.com/v1/messages`, model `claude-opus-5`) — clean, well-documented tool-use protocol. An OpenAI adapter is one more class behind the same Protocol.

---

## 2. Domain model — a typed node graph

The brief says "a sequence of steps, or a simple decision flow". A linear `steps[]` array satisfies the letter of that and paints us into a corner: it can't express fan-out, it forces every node to read the whole conversation, and a sub-workflow node has nowhere to plug in. A small typed graph costs about the same to build and is the honest model.

```
Workflow
  id · name · description
  provider          "anthropic"        # selects the adapter
  model             "claude-opus-5"
  system_prompt     str                # graph-wide persona, prepended for every agent node
  nodes             list[Node]         # JSON column
  edges             list[Edge]         # JSON column
  created_at / updated_at

Node
  id                str                # stable, referenced by edges
  kind              NodeKind
  label             str                # "Research", "Decide"
  config            dict               # kind-specific, validated by that kind's Pydantic model
  position          {x, y}             # reserved for a canvas later; unused by the v1 UI

Edge
  id
  source            {node_id, port}    # an output port
  target            {node_id, port}    # an input port
```

### 2.1 Ports and the type system

Every node **kind** declares a static port contract. This is the SmythOS idea: a connection is a typed data channel, so the builder rejects invalid wiring before the user ever runs the workflow, and the runtime validates the payload crossing it.

```python
PortType = Literal["text", "json", "number", "boolean", "any"]

class PortSpec(BaseModel):
    name: str
    type: PortType
    required: bool = True
    description: str = ""

class NodeKindSpec(Protocol):
    kind: ClassVar[str]
    inputs: ClassVar[list[PortSpec]]
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]]   # router outputs derive from its routes
    ConfigModel: ClassVar[type[BaseModel]]

    async def execute(self, ctx: NodeContext) -> dict[str, Any]:  # keyed by output port name
        ...
```

Compatibility rule (deliberately simple, one function, unit-tested): `any` connects to anything; identical types connect; `text ↔ json` is rejected with a message pointing at the fix. Enough to catch real mistakes without inventing a type lattice.

### 2.2 Node kinds in v1

| kind | inputs | outputs | what it does |
|---|---|---|---|
| `input` | — | `message: text`, `history: json` | Graph entry. Emits the user's turn. Exactly one per workflow |
| `agent` | `prompt: text`, plus optional named `context: any` inputs | `text: text` | Runs the tool-use loop with its configured instruction + tool subset |
| `tool` | derived from the tool's Pydantic input model | `result: text` | Calls one registry tool **deterministically**, no model in the path. Cheap, predictable, and proves tools aren't LLM-only |
| `router` | `input: text` | one `text` port per configured route | Classifies into exactly one route; only that branch activates |
| `output` | `response: text` | — | Terminal. Its value is the chat reply. Exactly one per workflow |

Reserved for later, no schema change needed: `subworkflow` (ports derived from the target workflow's `input`/`output` nodes) and `transform` (a template/JSONPath mapper between mismatched ports).

**`agent` node config:** `{ instruction, tools: list[str], max_tool_iterations }`. The workflow's `system_prompt` plus the node's `instruction` compose that node's system prompt — persona is graph-wide, task is node-local.

### 2.3 Persistence

SQLModel tables. `nodes` and `edges` as JSON columns — they're always read and written as a set, and JSON keeps the migration surface small while the shape is still moving.

```
Workflow   as above
Run        id · workflow_id · user_message · final_response · status
           events (JSON: list[RunEvent]) · tokens_in · tokens_out · duration_ms · created_at
SentEmail  id · to · subject · body · run_id · created_at        # mock outbox
```

Runs persist their full event log, so a chat transcript with all intermediate steps survives a refresh. Execution history for free.

Schema management: `SQLModel.metadata.create_all` on startup for v1, with Alembic noted as the production path. A tiny, honest choice for a local-first app; called out in the README rather than hidden.

---

## 3. Provider layer (raw HTTP)

`backend/app/llm/base.py` — a narrow Protocol in our vocabulary, deliberately not shaped like any vendor payload:

```python
class TextContent(BaseModel):     kind: Literal["text"];        text: str
class ToolCallContent(BaseModel): kind: Literal["tool_call"];   id: str; tool: str; input: dict
class ToolResultContent(BaseModel):
    kind: Literal["tool_result"]; call_id: str; output: str; is_error: bool = False

LLMContent = Annotated[TextContent | ToolCallContent | ToolResultContent, Field(discriminator="kind")]

class LLMRequest(BaseModel):
    model: str
    system: str
    messages: list[LLMMessage]                 # role: "user" | "assistant", content: list[LLMContent]
    tools: list[ToolSchema] = []               # [] = no tools this turn
    response_format: dict | None = None        # structured output — used by router nodes
    max_tokens: int = 8000

class LLMResponse(BaseModel):
    content: list[LLMContent]
    stop_reason: Literal["end", "tool_call", "max_tokens", "refusal"]
    usage: Usage

class LLMProvider(Protocol):
    id: str
    async def send(self, req: LLMRequest) -> LLMResponse: ...
```

`backend/app/llm/anthropic.py` implements it with a shared `httpx.AsyncClient`:

- Translates our discriminated union ↔ Anthropic content blocks (`text`, `tool_use`, `tool_result`) both ways. **This mapping is the interesting code** — precisely what an SDK hides.
- Headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
- `claude-opus-5` specifics: `max_tokens` ≥ 8000 (thinking is on by default and shares the output budget), `thinking: {"type": "adaptive"}`, `output_config: {"effort": "medium"}`. **Do not send** `temperature` / `top_p` / `top_k` / `budget_tokens` — this model 400s on them. No assistant-turn prefill.
- Router nodes use `output_config.format` (`json_schema`) — structured output, not JSON scraped from prose.
- Checks `stop_reason == "refusal"` before ever touching `content[0]`.
- Retry with exponential backoff + jitter on 429/5xx honouring `retry-after` (3 attempts); `httpx.Timeout(connect=10, read=120)`.
- Maps status → typed `LLMError` subclasses (`AuthError`, `RateLimitError`, `BadRequestError`, `ProviderServerError`, `NetworkError`) so a FastAPI exception handler returns a useful message, not a traceback.

`PROVIDERS: dict[str, LLMProvider]` maps `workflow.provider` → instance, built once at startup, with the `httpx` client managed by the FastAPI `lifespan` context.

---

## 4. Tool registry and dispatch

`backend/app/tools/registry.py`. New tool = one module + one `@register` decorator.

```python
class Tool(Protocol):
    id: ClassVar[str]
    name: ClassVar[str]
    description: ClassVar[str]          # say WHEN to call it, not just what it does
    Input: ClassVar[type[BaseModel]]
    async def execute(self, args: BaseModel, ctx: ToolContext) -> ToolResult: ...
```

`Input.model_json_schema()` produces the model-facing JSON Schema; `Input.model_validate()` is the runtime guard; the same model derives the `tool` node's input ports (§2.2). One definition, three uses — the reflection that makes a tool callable by an agent makes it wirable as a graph node.

**Dispatcher** (`dispatch.py`) is the safety layer: unknown id → error result; `ValidationError` → error result carrying Pydantic's message so the model can self-correct; exception or `asyncio.timeout(20)` → error result. **A failing tool never raises out of the loop** — it returns `is_error=True` and the model gets a chance to recover. Every dispatch is timed and emits events.

**v1 tools:**

| id | Behaviour |
|---|---|
| `calculator` | Arithmetic via a ~30-line **AST-whitelist evaluator** we write (`ast.parse` → allow only `BinOp`/`UnaryOp`/`Constant` with a fixed operator set). **Never `eval`.** Small enough to read, and safer than pulling a dependency |
| `web_search` | Tavily via `httpx` if `SEARCH_API_KEY` is set, else clearly-labelled mock results so the app runs with no third-party key. Top 3 as title/url/snippet |
| `send_email` | Mock: validates `to`/`subject`/`body` (Pydantic `EmailStr`), writes to `SentEmail`, logs, returns confirmation. Sends nothing |
| `current_datetime` | Current time for an IANA timezone (`zoneinfo`, stdlib). Trivial, but proves the registry generalises and grounds the others |

---

## 5. The event envelope

ADK's lesson: don't invent a new message type per thing that happens. One envelope, appended to an ordered log, is the entire observability and streaming story.

```python
class RunEvent(BaseModel):
    id: str
    run_id: str
    seq: int                       # monotonic, total order within a run
    ts: float
    author: Literal["user", "system", "node"]
    node_id: str | None = None     # omitted for run-level events
    branch: str | None = None      # parent path — set for sub-workflow events later
    type: RunEventType
    payload: dict
    partial: bool = False          # true for a delta; SSE streaming needs no new type
    final: bool = True             # last event for this (node_id, type) group

RunEventType = Literal[
    "run.start", "run.end", "run.error",
    "node.start", "node.end", "node.skipped",
    "edge.transfer",               # {source, target, type, preview} — the connection carrying data, observable
    "llm.request", "llm.response",
    "text.delta", "text.message",
    "tool.call", "tool.result",
    "route.decision",
]
```

Design consequences, all of which pay off immediately rather than "later":

- **Streaming is a flag, not a redesign.** v1 emits `text.message` with `final=True`. Add SSE and the same node emits `text.delta … partial=True` then a final `text.message`. The client reducer already handles both.
- **The client is a reducer.** `events → view state`. Live SSE and a run replayed from the DB run through the identical function, so replay can't drift from live.
- **`edge.transfer` makes the typed-connection model visible.** The user watches data move between nodes, which is the whole reason for a graph.
- **`branch` is the sub-workflow hook.** A nested run re-emits children with a branch path; the timeline renders them nested. No new event types.

`EventBus` is a small class with a sequence counter, one `emit()`, and pluggable sinks (v1: a list persisted to `Run.events`; later: an `asyncio.Queue` feeding SSE). Nodes receive it on `NodeContext` and never touch HTTP.

---

## 6. Execution engine

`backend/app/engine/` — three files, one job each.

### 6.1 Scheduler (`scheduler.py`)

Data-flow execution over the DAG, not a `for` loop over an array:

```
validate(graph)                       # exactly one input + one output node, no cycles, ports type-check
values: dict[(node_id, port), Any]; done: set; pruned: set
seed the input node with {message, history}

while True:
    ready = [n for n in nodes if n not in done|pruned and all required inputs present]
    if not ready: break
    results = await asyncio.gather(*(run(n) for n in ready))   # independent branches truly parallel
    for each result:
        for each outgoing edge from a produced port:
            validate the value against the target port type
            emit edge.transfer; values[target] = value
        if router: prune the subtree reachable only via non-chosen ports, emit node.skipped
```

Guards: `MAX_NODE_EXECUTIONS = 24` per run; per-node `asyncio.timeout`; cycle rejection at save time *and* at validate time. The final response is the `output` node's `response` value; if it never arrives, the run ends with `run.error` naming the starved node.

Fan-out and join fall out of this shape with no extra code — that's the argument for the graph over the array.

### 6.2 Agent loop (`agent_loop.py`)

Hand-written, ~60 lines, invoked by the `agent` node:

```
messages = [*history, user_turn]
for i in range(node.config.max_tool_iterations):        # default 8
    res = await provider.send(LLMRequest(model, system, messages, tools, max_tokens))
    emit llm.response {usage}

    if res.stop_reason == "refusal":    emit run.error; raise RefusalError
    if res.stop_reason == "max_tokens": emit warning; break

    messages.append(assistant_turn(res.content))        # FULL content, tool-call blocks included
    emit text.message per text block

    calls = [c for c in res.content if c.kind == "tool_call"]
    if not calls: return text                           # stop_reason "end"

    emit tool.call per call
    results = await asyncio.gather(*(dispatch(c) for c in calls))   # parallel calls run in parallel
    emit tool.result per result
    messages.append(user_turn(results))                 # ALL results in ONE turn
raise IterationLimitError()
```

Three protocol details that are easy to get wrong and belong in the README:

- The assistant's **full** content (tool-call blocks included) goes back into history, not just the text.
- **All** tool results for a turn go in a **single** user message. Splitting them trains the model out of parallel calls.
- Every `tool_call` needs exactly one matching `tool_result` with the same id — including failures.

### 6.3 Router (`router.py`)

Calls the provider with `response_format` = a Pydantic model `{label: Literal[*route_labels], reason: str}` (via `model_json_schema()`), emits `route.decision {chosen, reason}`, returns a value on exactly one output port. The scheduler prunes the rest. Deterministic branch semantics, no prose parsing.

---

## 7. API (FastAPI)

Pydantic request/response models throughout, so `/docs` is accurate OpenAPI with zero extra work. One error shape via exception handlers: `{"error": {"code", "message", "details"}}`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/node-kinds` | Port contracts + config JSON Schemas — the builder is generated from this, not hardcoded |
| `GET` | `/api/tools` | Tool registry metadata + input schemas |
| `GET` | `/api/providers` | Providers + models |
| `GET` `POST` | `/api/workflows` | List / create |
| `GET` `PUT` `DELETE` | `/api/workflows/{id}` | Fetch with nodes+edges / update / delete |
| `POST` | `/api/workflows/{id}/validate` | Graph check without running — powers inline builder errors |
| `POST` | `/api/workflows/{id}/run` | `{message, history}` → `{final_response, events, run_id, usage}` |
| `GET` | `/api/workflows/{id}/runs` | Recent runs with their event logs |
| `GET` | `/api/emails` | Mock outbox |

`GET /api/node-kinds` matters: the frontend renders port lists, connection validity and config forms from server-published Pydantic schemas, so **adding a node kind requires no frontend change**. Same trick as the tool registry, one level up.

v1 `run` returns a single JSON response carrying the full event list. Streaming is `POST /api/workflows/{id}/run?stream=1` returning SSE of the same envelopes (FastAPI `StreamingResponse` over the bus queue) — additive, and the client reducer is already written for it.

---

## 8. Frontend

Three routes (`react-router`):

- **`/` — Workflow list.** Cards: name, description, node count, tool badges. New / edit / delete / chat.
- **`/workflows/:id/edit` — Builder.** Name, description, provider + model, graph-wide system prompt. Then a **node list + connection panel**: add a node (kinds fetched from `/api/node-kinds`), edit its config in a form generated from the kind's JSON Schema, and wire ports via two dropdowns (source `node.port` → target `node.port`) filtered to type-compatible options. Invalid wiring is unselectable; `POST /validate` on change surfaces graph-level errors (missing output node, starved input, cycle) inline. Deliberately **not** a canvas in v1 — the graph *model* is the requirement, drag-and-drop is the bonus, and `position` is already in the schema for when a canvas is added.
- **`/workflows/:id/chat` — Chat.** Messages plus, per assistant turn, a timeline produced by reducing that turn's `RunEvent[]`: node start/end, `edge.transfer` chips showing data moving, tool calls with pretty-printed input, tool results (errors in red), router decisions with reasoning, final answer as the primary content. Header shows tokens and duration. Workflow picker to switch without leaving the page.

State: React Query for server state, `useState` for form drafts. No global store.

---

## 9. File layout

```
agentic-workflow/
├─ README.md                      # setup, architecture, design decisions, prior-art credits
├─ plan.md
├─ backend/
│  ├─ .env.example · requirements.txt · pyproject.toml
│  └─ app/
│     ├─ main.py                  # FastAPI app, lifespan (httpx client, DB), exception handlers, CORS
│     ├─ config.py                # pydantic-settings; fails fast on a missing API key
│     ├─ db.py                    # async engine + session dependency
│     ├─ models.py                # SQLModel tables: Workflow, Run, SentEmail
│     ├─ schemas.py               # API request/response models
│     ├─ errors.py                # AppError hierarchy → HTTP status mapping
│     ├─ routers/                 # workflows.py · node_kinds.py · tools.py · providers.py · emails.py
│     ├─ llm/
│     │  ├─ base.py               # LLMProvider Protocol + content union + errors
│     │  ├─ anthropic.py          # raw httpx, block mapping, retry, error mapping
│     │  └─ registry.py
│     ├─ tools/
│     │  ├─ registry.py · dispatch.py
│     │  └─ calculator.py · web_search.py · send_email.py · current_datetime.py
│     ├─ graph/
│     │  ├─ types.py              # PortType, PortSpec, NodeKindSpec, NodeContext
│     │  ├─ registry.py           # kind → spec
│     │  ├─ validate.py           # cycles, port compatibility, entry/exit checks
│     │  └─ kinds/                # input.py · agent.py · tool.py · router.py · output.py
│     ├─ engine/
│     │  ├─ scheduler.py · agent_loop.py · router.py · events.py
│     └─ seed.py                  # demo workflow so the app is non-empty on first run
│  └─ tests/                      # test_ports.py · test_validate.py · test_calculator.py
│                                 # test_anthropic_mapping.py (respx) · test_agent_loop.py · test_scheduler.py
└─ frontend/
   ├─ .env.example · package.json · vite.config.ts   # dev proxy /api → :8000
   └─ src/
      ├─ main.tsx · App.tsx · api.ts · types.ts
      ├─ state/eventReducer.ts    # RunEvent[] → timeline view state (shared by replay and SSE)
      ├─ pages/{WorkflowList,WorkflowEditor,Chat}.tsx
      └─ components/{NodeList,NodeConfigForm,ConnectionEditor,ToolPicker,Timeline,MessageBubble}.tsx
```

---

## 10. Build order

Every phase ends in something runnable — no big-bang integration.

**Phase 0 — Scaffold**
1. `backend`: venv, `pip install fastapi uvicorn[standard] sqlmodel aiosqlite httpx pydantic-settings python-dotenv`; dev: `pytest pytest-asyncio respx ruff`. `requirements.txt` pinned.
2. `frontend`: `npm create vite@latest . -- --template react-ts`; deps `react-router-dom @tanstack/react-query tailwindcss`.
3. `.env.example` both sides; `.env` gitignored; Vite proxy `/api` → `:8000`. Health endpoint returning 200.

**Phase 1 — Graph model and persistence**
4. SQLModel tables + `create_all` on startup.
5. `graph/types.py`, node-kind registry, `validate.py`. **Unit-test port compatibility and cycle detection first** — the whole engine rests on them.
6. Workflow CRUD + `/validate` + `/api/node-kinds`. Seed a demo workflow (`input → router → {search agent | direct agent} → output`) so the app is non-empty on first run.

**Phase 2 — Provider (before tools; everything downstream depends on it)**
7. `LLMProvider` Protocol + `AnthropicProvider` with block mapping both directions.
8. Throwaway script: send "say hi", print the response. Proves auth, headers, and the `claude-opus-5` parameter rules against the live API.
9. Extend it to a hardcoded single-tool round trip: request with one tool → parse `tool_use` → return `tool_result` → get final text. **Validate the protocol before building abstractions on it.**
10. Retry, timeout, typed error mapping. Lock the mapping in with `respx` tests so it never needs a live key again.

**Phase 3 — Tools**
11. Registry + the `Input` → JSON Schema path; unit-test the calculator AST evaluator (including that `__import__` and attribute access are rejected) and `send_email` validation.
12. Dispatcher: validation, timeout, never-raise.
13. `GET /api/tools`.

**Phase 4 — Engine**
14. `events.py` — envelope + bus + list sink.
15. `agent_loop.py`, tested against `respx` fixtures for the multi-turn tool exchange.
16. Node kinds `input`, `agent`, `output` — get a one-agent graph running end to end.
17. `scheduler.py` — ready queue, edge transfer, pruning, caps.
18. `router.py` + the `router` node kind; then the deterministic `tool` node.
19. `POST /run` + run persistence.

**Phase 5 — Frontend**
20. API client, React Query, Tailwind.
21. Workflow list.
22. Builder: node list, schema-driven config forms, connection editor with type filtering, inline validation.
23. Chat: `eventReducer` + timeline + message list.

**Phase 6 — Hardening & docs**
24. Error paths end to end: missing API key at boot, refusal, tool failure, iteration cap, node-execution cap, starved output node, cyclic graph, 404, malformed workflow.
25. README: setup, architecture write-up, design decisions (why no SDK, why a typed graph over a step array, why one event envelope, why Pydantic schemas are the single source of truth), the borrowed-mental-models table with credits, how to add a tool / node kind / provider, screenshots.

---

## 11. Local setup (goes in README)

```bash
# backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # add ANTHROPIC_API_KEY
python -m app.seed            # demo workflow
uvicorn app.main:app --reload --port 8000    # API + docs at /docs

# frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev                   # :5173
```

`backend/.env.example`:
```
ANTHROPIC_API_KEY=sk-ant-...
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-5
DATABASE_URL=sqlite+aiosqlite:///./workflows.db
PORT=8000
CORS_ORIGINS=http://localhost:5173
# Optional — web_search falls back to mock results when unset
SEARCH_API_KEY=
```

---

## 12. Out of scope for v1 — and the hook each one lands on

| Deferred | Hook already in place |
|---|---|
| Streaming responses | `RunEvent.partial` / `final`; client is a reducer over events; add an SSE sink over an `asyncio.Queue` |
| Drag-and-drop canvas | `Node.position` in the schema; the builder already edits a graph, not a list |
| Sub-workflows / agent composition | `subworkflow` node kind + `RunEvent.branch`; the scheduler recurses, no new event types |
| Multiple LLM providers | `LLMProvider` Protocol + registry; `workflow.provider` already persisted |
| Workflow versioning | Copy-on-write of the nodes/edges JSON with a `version` column |
| Execution history UI | `Run.events` already persists full traces; `GET /runs` exists |
| Docker, auth | Nothing structural blocks either; `uvicorn` + a static frontend build is a two-service compose file |

---

## 13. Risks

- **Graph scope creep.** The biggest risk is building a workflow engine instead of shipping the brief. Mitigation: five node kinds, one type-compatibility function, no transforms, no canvas in v1. Phase 4 must produce a *running* one-agent graph before the router exists.
- **Protocol mapping bugs.** Hand-writing the block translation is the real cost of dropping the SDK. Mitigated by Phase 2 step 9 (a bare hardcoded tool round-trip proven against the live API before anything is layered on it) and then frozen with `respx` tests.
- **Async footguns.** Blocking calls inside `async def` would stall the loop. Rule: every I/O path is `httpx.AsyncClient` or the async SQLModel session; anything CPU-bound (there is none in v1 beyond the AST evaluator) goes through `asyncio.to_thread`.
- **Starved / unreachable nodes.** A mis-wired graph could stall. The scheduler detects "no ready nodes and output unset" and ends with `run.error` naming the starved node; `/validate` catches most cases at save time.
- **Tool-loop cost.** 8 tool iterations per agent node, 24 node executions per run; tokens recorded per run and shown in the UI.
- **`max_tokens` truncation.** Thinking shares the output budget on `claude-opus-5` — 8000 minimum, and `stop_reason == "max_tokens"` is surfaced rather than silently returning half an answer.
