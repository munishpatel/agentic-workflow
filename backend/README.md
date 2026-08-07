# Workflow Studio — Backend

FastAPI service for building, saving and running AI workflows. A workflow is a
typed graph of agents, tools and routers; the execution engine runs it and emits
every step as an ordered event log.

The client is [`../frontend`](../frontend). For full-stack setup, see the
[root README](../README.md).

## Requirements

- Python 3.13+
- [`uv`](https://docs.astral.sh/uv/) (or pip — see below)

## Setup

```bash
uv sync                                      # venv + locked dependencies
cp .env.example .env                         # then add ANTHROPIC_API_KEY
uv run python -m app.seed                    # two demo workflows
uv run uvicorn app.main:app --reload --port 8000
```

- API docs — <http://localhost:8000/docs>
- Health — <http://localhost:8000/api/health>

<details>
<summary>Without <code>uv</code></summary>

```bash
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

</details>

The service boots without an API key. Browsing, editing and validating workflows
all work; only `POST /run` returns `503 missing_api_key`.

## Commands

| | |
|---|---|
| `uv run uvicorn app.main:app --reload --port 8000` | Dev server |
| `uv run pytest` | Test suite — 222 tests, no API key needed |
| `uv run python -m app.seed` | Seed demo workflows (idempotent) |
| `uv run ruff check app tests` | Lint |
| `uv run ruff format app tests` | Format |

## Configuration

Read from the environment or `.env`.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(empty)* | Required to run a workflow |
| `LLM_PROVIDER` | `anthropic` | |
| `LLM_MODEL` | `claude-sonnet-5` | Default for new workflows; each workflow stores its own |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | |
| `DATABASE_URL` | `sqlite+aiosqlite:///./workflows.db` | |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated |
| `SEARCH_API_KEY` | *(empty)* | Tavily. Without it, `web_search` returns labelled mock results |

Switching between `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5`
requires no code change. `LLM_MODEL` applies to newly created workflows; change
existing ones in the builder's Model dropdown.

## API

All routes are under `/api`.

| Method | Path | |
|---|---|---|
| `GET` | `/health` | Status, configured provider and model |
| `GET` | `/workflows` | List |
| `POST` | `/workflows` | Create |
| `GET` | `/workflows/{id}` | Fetch one |
| `PUT` | `/workflows/{id}` | Update |
| `DELETE` | `/workflows/{id}` | Delete |
| `POST` | `/workflows/{id}/validate` | Validate the graph without running it |
| `POST` | `/workflows/{id}/run` | Execute; returns the final response and event log |
| `GET` | `/workflows/{id}/runs` | Run history |
| `GET` | `/runs/{id}` | Fetch one run |
| `GET` | `/node-kinds` | Port contracts and config JSON Schemas |
| `GET` | `/tools` | Available tools with their input schemas |
| `GET` | `/providers` | Providers and their models |
| `GET` | `/emails` | Outbox written by the `send_email` tool |

### Error handling

Failures before a run starts are HTTP errors. Failures during a run return
**200** with a partial event log ending in `run.error` — which nodes ran, which
tools were called and where it stopped is the useful part of a failed run.

| Condition | Status | `code` |
|---|---|---|
| No LLM credential | 503 | `missing_api_key` |
| Workflow or run not found | 404 | `not_found` |
| Graph has error-level issues | 422 | `validation_error` (issues in `details`) |
| Provider rate limit | 200 | `rate_limit` (in `run.error`) |
| Provider auth / unavailable | 200 | `provider_auth` / `provider_unavailable` |
| Unhandled | 500 | `internal_error` (traceback logged, not returned) |

## Project structure

```
app/
├─ routers/     workflows · registry · runs      HTTP layer, Pydantic in/out
├─ engine/      runner → scheduler → agent_loop / router
│               events.py — the event bus
├─ graph/       types · ports · kinds · validate  the typed graph model
├─ tools/       registry · dispatch · 4 tools
├─ llm/         base (Protocol) · anthropic (raw HTTPS via httpx)
├─ models.py    SQLModel / SQLite
└─ config.py    pydantic-settings
```

No agent framework is used. The tool-use loop, tool dispatch, graph scheduler,
branch pruning and event emission are implemented here; the LLM is reached over
raw HTTPS behind a provider `Protocol`, so adding a provider means one new
adapter.

### The graph model

Nodes declare typed input and output ports; edges connect ports and carry values.
The scheduler runs every ready node concurrently, so fan-out and join come for
free. A router activates one output port, and everything reachable only through
the others is skipped and reported as skipped in the timeline.

Input ports are single-assignment, **except** when the two sources sit behind
different output ports of the same router — a router activates one branch, so
those edges can never both deliver. This is what makes `input → router → {A|B} →
output` legal. See `are_mutually_exclusive` in `graph/ports.py`.

### The event envelope

Every observable step in a run is one `RunEvent`:

```python
RunEvent(id, run_id, seq, ts, author, node_id, branch, type, payload, partial, final)
```

`seq` is monotonic and unique within a run; clients sort by it, never by `ts`.
`emit()` assigns `seq` synchronously — nodes run concurrently under
`asyncio.gather`, so an `await` between read and increment would produce
duplicates.

`partial` / `final` are in the envelope but v1 only sends `final=True`. Adding
SSE means changing the transport, not the contract.

### Tool-use protocol

The agent loop in `engine/agent_loop.py` follows three rules, each of which
causes a 400 or a silent behaviour change when broken:

1. Append the assistant's full `content`, tool-call blocks included.
2. All tool results for a turn go in one user message — splitting them across
   messages trains the model out of parallel tool calls.
3. Every `tool_call` gets exactly one `tool_result` with the same id, including
   failures.

Model-specific: check `stop_reason == "refusal"` before reading `content`, since
a refusal is a 200 whose `content` may be empty. Claude 5 models also reject
`temperature`, `top_p`, `top_k` and `budget_tokens`; thinking is on by default and
shares the output budget.

## Extending

### Add a tool

1. Create `app/tools/my_tool.py` with a Pydantic `Input` model and an `execute`.
2. Decorate the class with `@register`.
3. Import it at the bottom of `app/tools/registry.py`.

No frontend change is required. `Input.model_json_schema()` serves as the
model-facing schema, the runtime validator and the builder's argument form.
Write the `description` as *when to call this* — an under-described tool is the
most common cause of an agent that never uses it.

### Add a node kind

1. Add a config model and a class with `kind`, `label`, `description`, `inputs`,
   `outputs` and `ConfigModel` in `app/graph/kinds.py`, decorated with `@register`.
2. Add its execution branch in `app/engine/scheduler.py::_execute`.

No frontend change is required — `GET /api/node-kinds` publishes the ports and
config schema, and the builder generates the palette entry, canvas node and
config form from it. The exception is dynamic output ports: only `router` has
them, and a second such kind would need frontend work.

## Testing

```bash
uv run pytest        # 222 tests, no API key or network access needed
```

| File | Covers |
|---|---|
| `test_ports.py` | Type compatibility, mutual exclusion, cycle detection |
| `test_validate.py` | Every validation code, and that the seeded graphs validate clean |
| `test_calculator.py` | Arithmetic, and rejection of imports, attribute access and calls |
| `test_dispatch.py` | Unknown tool, bad arguments, raising tool, timeout — never raises |
| `test_anthropic_mapping.py` | Wire-format round trips, refusal handling, banned parameters |
| `test_provider_http.py` | Retry on 429, no retry on 400, error mapping (respx) |
| `test_agent_loop.py` | The three protocol rules, iteration cap, refusal, usage |
| `test_scheduler.py` | Linear runs, router pruning, starved output, node cap |
| `test_events.py` | `seq` uniqueness under 400 concurrent emissions |
| `test_api_workflows.py` | CRUD, round-tripping, error envelope |
| `test_api_conformance.py` | The frontend's acceptance suite, ported |

The suite neutralises ambient credentials in `conftest.py`, so a populated `.env`
cannot change the result.

## Limitations

- `create_all` on startup rather than Alembic migrations.
- `web_search` returns labelled mock results when `SEARCH_API_KEY` is unset.
- `tool` node arguments are literal only — no per-argument wired ports.
- Responses are not streamed.
- `send_email` records to an outbox rather than sending.
- No auth, multi-tenancy, pagination or rate limiting.
