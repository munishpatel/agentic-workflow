# Workflow Studio

Build a graph of AI agents, tools and routers; save it; chat with it; and watch
every step it took.

- **`frontend/`** — React + TypeScript builder and chat UI. [README](frontend/README.md)
- **`backend/`** — FastAPI service, no agent framework. [README](backend/README.md)

## Quick start

```bash
# backend
cd backend && uv sync && cp .env.example .env   # add ANTHROPIC_API_KEY
uv run python -m app.seed
uv run uvicorn app.main:app --reload --port 8000

# frontend (in another shell)
cd frontend && npm install
# .env: VITE_USE_MOCKS=false  to use the backend, true to run standalone
npm run dev
```

The frontend also runs **entirely without the backend** (`VITE_USE_MOCKS=true`),
against an MSW mock of the same contract.

## Docs

| | |
|---|---|
| `plan.md` | Original whole-system design and rationale |
| `frontend-plan.md` · `backend-plan.md` | Per-half implementation plans |
| `frontend-imp.md` | The contract between the two halves — normative |
