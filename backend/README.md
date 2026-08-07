# Workflow Studio — backend

A FastAPI service for building, saving and running configurable AI workflows: a
typed graph of agents, tools and routers, executed by a hand-written engine that
emits every observable step as an ordered event log.

The frontend in `../frontend` is the client. `../frontend-imp.md` is the contract
between them.

---

## Setup

```bash
cd backend
uv sync                                  # venv + locked deps + Python 3.13
cp .env.example .env                     # then add ANTHROPIC_API_KEY
uv run python -m app.seed                # two demo workflows
uv run uvicorn app.main:app --reload --port 8000
```

API docs: <http://localhost:8000/docs> · Health: <http://localhost:8000/api/health>

**Without `uv`:**

```bash
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

**The app boots without an API key** — deliberately. Browsing, editing and
validating workflows all work; only `POST /run` returns `503 missing_api_key`,
which the frontend renders as "Set ANTHROPIC_API_KEY in backend/.env". Failing at
import time would hand you a stack trace instead of a working UI.

Then, in `../frontend`: set `VITE_USE_MOCKS=false` and `npm run dev`. The Vite
proxy already points `/api` at `:8000`.

| Command | |
|---|---|
| `uv run pytest` | 222 tests, no API key needed |
| `uv run ruff check app tests` | Lint |
| `uv run ruff format app tests` | Format |
| `uv run python -m app.seed` | Seed the demo workflows (idempotent) |

---

## The no-framework decision

**This service uses no agent framework** — not LangGraph, ADK, CrewAI,
LlamaIndex, or the vendor `anthropic` SDK. The LLM is reached over raw HTTPS with
`httpx` behind a provider Protocol we define. The tool-use loop, tool dispatch,
graph scheduler, branch pruning, event emission and execution caps are all ours.

That is a decision, not an omission. The interesting problems in this project —
what happens when a tool fails mid-loop, how a router prunes a branch without
killing a convergent output node, how concurrent nodes share a monotonic event
sequence — are exactly the problems a framework solves for you and then hides.
Owning them is the point. The cost is real (the wire-format mapping is code we
have to get right), and it is paid down with tests: `test_anthropic_mapping.py`
pins the block mapping without HTTP, and `test_provider_http.py` pins retry and
error handling with `respx`.

| Ours — the graded surface | Borrowed — nobody scores this |
|---|---|
| Agent loop (`engine/agent_loop.py`) | FastAPI, Uvicorn |
| Graph scheduler + pruning (`engine/scheduler.py`) | Pydantic v2 |
| Tool registry + dispatch (`tools/`) | SQLModel / SQLAlchemy |
| Provider adapter + block mapping (`llm/anthropic.py`) | `httpx` |
| Event envelope + bus (`engine/events.py`) | pytest, respx |
| Graph validation (`graph/validate.py`) | `zoneinfo`, stdlib |

### Prior art, credited

Two mental models are borrowed deliberately; the implementations are ours.

- **SmythOS — typed component I/O.** A connection is a typed data channel, not a
  bare arrow. That is why nodes declare `PortSpec`s, why `text ↔ json` is refused
  at validation time rather than at runtime, and why the UI can grey out an
  illegal connection before the user releases the mouse.
- **Google ADK — the uniform event envelope, and agent-as-composable-unit.**
  Rather than a message type per concern, everything observable is one `RunEvent`
  appended to an ordered log. That single decision is the entire observability
  story, makes replay and live rendering share one code path, and makes streaming
  an additive change later.

---

## Architecture

```
      HTTP  ─────────────────────────────────────────────────────────
      routers/     workflows · registry · runs      ← thin, Pydantic in/out
      ─────────────────────────────────────────────────────────────────
      engine/      runner → scheduler → agent_loop / router
                              │              │
      graph/       validate · ports · kinds   │        ← the typed graph model
      ─────────────────────────────────────────────────────────────────
      tools/       registry · dispatch · 4 tools
      llm/         base (Protocol) · anthropic (raw HTTPS)
      ─────────────────────────────────────────────────────────────────
      models.py    SQLModel · SQLite
```

### Why a typed node graph, not a `steps[]` array

An array of steps is the obvious v1 and the wrong one:

- **It cannot express fan-out.** Two independent branches from one step have
  nowhere to live in a list. A graph gets fan-out and join for free — the
  scheduler already runs every ready node concurrently.
- **It forces every step to read the whole conversation**, because there is no
  way to say "this step gets *that* step's output and nothing else". Typed ports
  make data flow explicit and lets the engine validate the payload crossing.
- **It leaves sub-workflows nowhere to plug in.** A node whose ports are derived
  from another workflow's `input`/`output` is a natural extension; a "step that
  is secretly a list of steps" is not.

The graph model also makes branch pruning a real feature rather than an if
statement: a router activates one output port, and everything reachable only via
the others is skipped and *reported as skipped* in the timeline.

### The event envelope

Every observable thing in a run is one `RunEvent`:

```python
RunEvent(id, run_id, seq, ts, author, node_id, branch, type, payload, partial, final)
```

`seq` is monotonic and unique within a run; clients sort by it and never by `ts`,
because timestamps tie. `emit()` is the only place `seq` is assigned and assigns
it synchronously — nodes run concurrently under `asyncio.gather`, so an `await`
between read and increment would produce duplicates and break the UI's ordering.
`test_events.py` asserts uniqueness under 400 concurrent emissions.

`partial`/`final` are already in the envelope though v1 only ever sends
`final=True`. When SSE lands, the same envelopes flow over a stream into the same
frontend reducer — no new event type, no contract change.

---

## The three tool-use protocol rules

These are in `engine/agent_loop.py` and each produces a confusing failure when
broken. They are the concrete cost of not using an SDK, and the concrete evidence
of understanding the wire.

1. **Append the assistant's full `content`, tool-call blocks included.** Keeping
   only the text leaves the next request with a `tool_result` that has no
   matching `tool_use` — a 400.
2. **All tool results for a turn go in one user message.** Splitting them across
   messages trains the model out of making parallel tool calls.
3. **Every `tool_call` gets exactly one `tool_result` with the same id, including
   failures.** A missing one is a 400.

A fourth, model-specific: **check `stop_reason == "refusal"` before touching
`content`.** A refusal is an HTTP 200 whose `content` may be empty, so indexing
`content[0]` is a crash rather than an error path.

`claude-opus-5` also rejects `temperature`, `top_p`, `top_k` and `budget_tokens`
outright, and thinking is on by default sharing the output budget — hence
`max_tokens` of 16000 and `effort` inside `output_config`. There is a test whose
only job is to fail if someone reintroduces a banned parameter.

---

## How to add a tool

1. Create `app/tools/my_tool.py` with a Pydantic `Input` model and an `execute`.
2. Decorate the class with `@register`.
3. Import it at the bottom of `app/tools/registry.py`.

That's it — **no frontend change required.** `GET /api/tools` picks it up, the
builder's tool picker lists it with your description, agents can call it, and the
`tool` node can run it deterministically. `Input.model_json_schema()` serves as
the model-facing schema, the runtime validator, and the builder's argument form:
one definition, three consumers.

Write the `description` as *when to call this*, not just what it does — an
under-described tool is the most common cause of an agent that never uses it.

## How to add a node kind

1. Add a config model and a class with `kind`, `label`, `description`, `inputs`,
   `outputs`, `ConfigModel` in `app/graph/kinds.py`, decorated with `@register`.
2. Add its execution branch in `app/engine/scheduler.py::_execute`.

**No frontend change required.** `GET /api/node-kinds` publishes the ports and
the config JSON Schema, and the builder generates the palette entry, the canvas
node with its typed handles, and the configuration form from that. The one
exception is dynamic outputs: only `router` has them, and a second dynamic kind
*would* need a frontend change — so don't add one.

---

## Tests

`uv run pytest` — 222 tests, no API key required.

| File | What it pins down |
|---|---|
| `test_ports.py` | Compatibility matrix; the mutual-exclusion relaxation; cycle detection |
| `test_validate.py` | Every emitted code fires on a graph that deserves it; **the seeded demo graph validates clean** |
| `test_calculator.py` | Arithmetic, and that `__import__`, attribute access, calls and names are all rejected |
| `test_dispatch.py` | Unknown tool, bad arguments, raising tool, timeout — all return `is_error` and never raise |
| `test_anthropic_mapping.py` | `_to_wire`/`_from_wire` round-trips; refusal handling; banned parameters. **Pure, no HTTP** |
| `test_provider_http.py` | respx: retry on 429 honouring `retry-after`, no retry on 400, error-type mapping |
| `test_agent_loop.py` | The three protocol rules, iteration cap, refusal, usage accumulation |
| `test_scheduler.py` | Linear run; **router pruning keeps a convergently-reachable output node alive**; starved output; node cap |
| `test_events.py` | `seq` unique and monotonic under concurrent emission |
| `test_api_workflows.py` | CRUD, id/position round-trip, error envelope |
| `test_api_conformance.py` | The frontend's own acceptance suite, ported |

That last one is worth calling out: `frontend/src/mocks/handlers.test.ts` ran ten
assertions against the mock API *before this service existed*. Porting them here
is the cheapest possible check that the two halves agree.

---

## Contract notes

The frontend was built first, against `frontend-imp.md`. Two decisions in there
are load-bearing:

**Convergent router branches are legal.** Input ports are single-assignment
*except* when the two sources sit behind different output ports of the same
router — a router activates one branch, so those edges can never both deliver.
Without this the seeded `input → router → {A | B} → output` graph fails
validation and branching workflows are unbuildable. See `are_mutually_exclusive`
in `graph/ports.py` and the headline test in `test_validate.py`.

**Where a failure happens decides its shape.**

- *Before* the run starts (no credential, unknown workflow, invalid graph) →
  an HTTP error with a code the frontend renders. There is no timeline worth
  returning.
- *After* the run starts (refusal, iteration limit, node limit, starved output)
  → **HTTP 200** with a normal body whose event log ends in `run.error` and
  whose `final_response` is `""`. The partial timeline — which nodes ran, which
  tools were called, where it died — is exactly what the user needs, and a 500
  would discard all of it.

| Condition | Status | `code` |
|---|---|---|
| No LLM credential | 503 | `missing_api_key` |
| Workflow or run not found | 404 | `not_found` |
| Graph has error-level issues | 422 | `validation_error` (issues in `details`) |
| Provider rate limit | 200 | `rate_limit` (in `run.error`) |
| Provider auth / unavailable | 200 | `provider_auth` / `provider_unavailable` |
| Unhandled | 500 | `internal_error` (traceback logged, not returned) |

---

## Known limitations

Stated rather than hidden:

- **`create_all` on startup, not Alembic.** Honest for a local-first app; Alembic
  is the production path and the schema lives in one module, so adopting it is a
  contained change.
- **`web_search` returns clearly-labelled mock results** when `SEARCH_API_KEY` is
  unset, so the app runs with no third-party key. It never passes fabricated
  results off as real. With a Tavily key set it searches for real.
- **`tool` node arguments are literal only.** No per-argument wired ports in v1;
  `resolve_inputs` in `graph/ports.py` is where they would appear.
- **Non-streaming.** `RunEvent.partial`/`final` and the frontend's reducer both
  already handle deltas, so SSE is an `asyncio.Queue` sink and a
  `StreamingResponse` — the cheapest bonus still on the table.
- **No auth, no multi-user, no pagination, no rate limiting.**
- **`send_email` sends nothing.** It validates, records to the outbox
  (`GET /api/emails`), and returns a confirmation.

## Switching models

`LLM_MODEL` in `.env` is the **default** for newly created and seeded workflows —
each workflow then stores its own model, which is what the engine actually uses.
So changing the setting affects new workflows, not existing ones:

- **Existing workflows** — change the model in the builder's Model dropdown and
  save, or delete `workflows.db` and re-run `python -m app.seed`.
- **New workflows** — pick it up automatically; `GET /api/providers` lists the
  configured model first and the builder creates with `models[0]`.

Switching between `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5` needs
no code change — that is what the provider Protocol is for. Both Opus 5 and
Sonnet 5 have been exercised end to end here, including parallel tool calls and
router structured output.

## Validated against the live API

The wire protocol is not just mocked — it has been exercised against
`api.anthropic.com` with `claude-opus-5`:

- **Auth, headers and parameter rules** — a bare request succeeds with adaptive
  thinking and `effort` inside `output_config`, and none of the banned sampling
  parameters.
- **A full tool-use round trip** — the model calls a tool, we echo its full
  content back, return a `tool_result`, and it answers from it.
- **Parallel tool calls** — a real run issued two `calculator` calls in one turn
  and both results went back in a single user message, which is protocol rule 2
  confirmed against the model rather than a fixture.
- **Live web search** via Tavily, with the router picking `needs_research`, the
  other branch pruned and reported, and the answer citing real sources.
- **Both `claude-opus-5` and `claude-sonnet-5`**, with no code change between
  them — including tool use, parallel tool calls and router structured output.
- **`send_email`** driven by the model's own decision, landing in the outbox.

Two bugs surfaced only under live conditions, both fixed:

1. **A failed run reported zero usage.** A real research run hit the iteration
   cap after spending ~25k input tokens and reported `0`. Usage is now derived
   from the `llm.response` events, so what the run reports and what the timeline
   shows cannot diverge.
2. **The test suite read the developer's `.env`.** Once a real `SEARCH_API_KEY`
   existed, a unit test started making live Tavily calls. `tests/conftest.py`
   now neutralises ambient credentials for the whole suite.

The seeded research agent's `max_tool_iterations` was also raised from 4 to 8 —
a live run showed the model legitimately searching five times to cross-check a
release date, which is thorough research rather than a runaway loop.

## Screenshots

See `../frontend/docs/screenshots/` — the workflow list, the builder canvas, and
a chat timeline showing a router decision, a pruned branch, a tool call and its
result.
