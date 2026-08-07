# Workflow Studio

Build a graph of AI agents, tools and routers; save it; chat with it; and watch
every step it took.

- **`frontend/`** — React + TypeScript builder and chat UI. [README](frontend/README.md)
- **`backend/`** — FastAPI service, no agent framework. [README](backend/README.md)

---

## Prerequisites

| | Version | Check with | Notes |
|---|---|---|---|
| **Python** | 3.13+ | `python3 --version` | |
| **Node.js** | 20.19+ or 22.12+ | `node -v` | Required by Vite 8 |
| **uv** | any recent | `uv --version` | Optional — [pip fallback below](#without-uv) |
| **Anthropic API key** | — | — | Optional — see [Two ways to run](#two-ways-to-run) |

Install `uv` if you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Two ways to run

Decide this first, because it changes one line of setup.

| | What runs | Needs an API key |
|---|---|---|
| **Demo mode** | Frontend only. The entire API is served in-browser by MSW, seeded with two workflows and realistic run timelines. | No |
| **Full stack** | Real FastAPI backend, real Claude calls, SQLite persistence. | Yes |

Demo mode is the fastest way to see the product — [skip to it](#demo-mode-frontend-only).
Everything below is the full stack.

---

## Setup — full stack

### 1. Start the backend

```bash
cd backend
uv sync                         # creates .venv, installs locked deps
cp .env.example .env
```

Open `backend/.env` and set your key:

```ini
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-5       # or claude-opus-5, claude-haiku-4-5
```

Then seed the demo workflows and start the server:

```bash
uv run python -m app.seed       # idempotent — safe to re-run
uv run uvicorn app.main:app --reload --port 8000
```

**Leave this running** and open a second terminal for the frontend.

<a id="without-uv"></a>
<details>
<summary>Without <code>uv</code></summary>

```bash
cd backend
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then add ANTHROPIC_API_KEY
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

</details>

### 2. Start the frontend

```bash
cd frontend
npm install
cp .env.example .env
```

Open `frontend/.env` and **change one value** — the example ships in demo mode:

```ini
VITE_USE_MOCKS=false
```

Then:

```bash
npm run dev
```

### 3. Verify

```bash
curl http://localhost:8000/api/health
# {"status":"ok","provider":"anthropic","model":"claude-sonnet-5","llm_configured":true}
```

`llm_configured: false` means the key didn't load — check `backend/.env` and restart the server.

Now open **<http://localhost:5173>**. You should see two seeded workflows. Open
**Math helper**, ask *"A dinner bill is $1200 with 8% tax, split 3 ways — what does
each person pay?"*, and the timeline should show real `calculator` tool calls.

| | |
|---|---|
| App | <http://localhost:5173> |
| API docs (Swagger) | <http://localhost:8000/docs> |
| Health | <http://localhost:8000/api/health> |

<a id="demo-mode-frontend-only"></a>
## Demo mode — frontend only

No backend, no API key, no Python:

```bash
cd frontend
npm install && cp .env.example .env    # VITE_USE_MOCKS=true is the default
npm run dev
```

MSW serves the full API contract in the browser. Workflows persist in
`localStorage`, transcripts in `sessionStorage`. **Mock API → Reset demo data** in
the header restores the seed. Failure paths are reachable by keyword — say
`refuse`, `boom`, or a message containing `fail` in chat to see how the UI handles
each. Details in the [frontend README](frontend/README.md#the-mock-api).

---

## Configuration

Each half has its own `.env`, and they stay separate on purpose: `backend/.env`
holds real secrets, while every `VITE_*` var is inlined into the browser bundle
at build time and is therefore public by construction. Both `.env` files are
gitignored; only the `.env.example` templates are committed.

**`backend/.env`**

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(empty)* | Required to run a workflow, not to browse or edit one |
| `LLM_MODEL` | `claude-sonnet-5` | New workflows are created with this; existing ones keep their stored model |
| `DATABASE_URL` | `sqlite+aiosqlite:///./workflows.db` | |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated; unused behind the Vite proxy |
| `SEARCH_API_KEY` | *(empty)* | Tavily. Without it `web_search` returns clearly-labelled mock results |

**`frontend/.env`**

| Variable | Default | |
|---|---|---|
| `VITE_USE_MOCKS` | `true` | `false` to talk to the real backend |
| `VITE_API_BASE_URL` | *(empty)* | Leave empty — the dev server proxies `/api` to `:8000` |

### Switching models

Change `LLM_MODEL` in `backend/.env` and restart. That sets the default for
**newly created** workflows. Workflows already in the database keep the model
they were saved with — change those in the builder's **Model** dropdown, or
delete `backend/workflows.db` and re-seed (this also discards run history).

---

## Tests

```bash
cd backend  && uv run pytest        # 222 tests, no API key needed
cd frontend && npm test             # 79 tests, no browser needed
```

Neither suite makes a network call. The backend suite neutralises ambient
credentials, so a populated `backend/.env` can't change the result.

```bash
cd backend  && uv run ruff check app tests
cd frontend && npm run typecheck && npm run lint
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| UI loads but shows a "Mock API" badge | `VITE_USE_MOCKS` is still `true` | Set it to `false` in `frontend/.env`, restart `npm run dev` — Vite reads env at startup only |
| Chat returns `503 missing_api_key` | Key not loaded | Check `backend/.env`, then `curl …/api/health` for `llm_configured` |
| Empty workflow list on the full stack | Database never seeded | `cd backend && uv run python -m app.seed` |
| `Address already in use` | Port 8000 or 5173 taken | `lsof -ti:8000 \| xargs kill` |
| Frontend requests 404 | Backend not running, or on a different port | The Vite proxy is hardcoded to `:8000` in `vite.config.ts` |
| `uv sync` fails on Python version | 3.13 not available | `uv python install 3.13` |
| Search results look synthetic | `SEARCH_API_KEY` unset | Expected — add a Tavily key for live search |

---

## Docs

| | |
|---|---|
| [`frontend/README.md`](frontend/README.md) · [`backend/README.md`](backend/README.md) | Architecture and design decisions per half |
| `plan.md` | Original whole-system design and rationale |
| `frontend-plan.md` · `backend-plan.md` | Per-half implementation plans |
| `frontend-imp.md` | The contract between the two halves — normative |
