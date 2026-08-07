from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.config import get_settings
from app.engine.events import RunEvent
from app.graph.types import Edge, Node
from app.models import Workflow

# The parse-at-the-boundary layer. The DB stores nodes and edges as `dict`; the
# engine only ever sees validated `Node`/`Edge`. Everything crossing between
# them goes through here.


class WorkflowInput(BaseModel):
    """POST/PUT body. The server owns `id`, `created_at` and `updated_at`."""

    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    provider: str = "anthropic"
    # Falls back to the configured LLM_MODEL rather than a hardcoded id, so the
    # setting is meaningful for anything created without an explicit model.
    model: str = Field(default_factory=lambda: get_settings().llm_model)
    system_prompt: str = ""
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)


class WorkflowRead(BaseModel):
    id: str
    name: str
    description: str | None
    provider: str
    model: str
    system_prompt: str
    nodes: list[Node]
    edges: list[Edge]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: Workflow) -> "WorkflowRead":
        return cls(
            id=row.id,
            name=row.name,
            description=row.description,
            provider=row.provider,
            model=row.model,
            system_prompt=row.system_prompt,
            nodes=[Node.model_validate(node) for node in row.nodes],
            edges=[Edge.model_validate(edge) for edge in row.edges],
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class WorkflowSummary(BaseModel):
    """
    What `GET /api/workflows` returns — the list page renders these as badges
    and never fetches a full graph.
    """

    id: str
    name: str
    description: str | None
    model: str
    node_count: int
    tool_ids: list[str]
    updated_at: datetime

    @classmethod
    def from_row(cls, row: Workflow) -> "WorkflowSummary":
        return cls(
            id=row.id,
            name=row.name,
            description=row.description,
            model=row.model,
            node_count=len(row.nodes),
            tool_ids=collect_tool_ids(row.nodes),
            updated_at=row.updated_at,
        )


def collect_tool_ids(nodes: list[dict[str, Any]]) -> list[str]:
    """
    The de-duplicated union of every `agent.tools` entry and every
    `tool.tool_id` in the graph. Order is first-seen so the badges are stable.
    """
    seen: list[str] = []
    for node in nodes:
        config = node.get("config") or {}
        for tool_id in config.get("tools") or []:
            if isinstance(tool_id, str) and tool_id and tool_id not in seen:
                seen.append(tool_id)
        single = config.get("tool_id")
        if isinstance(single, str) and single and single not in seen:
            seen.append(single)
    return seen


def graph_to_columns(payload: WorkflowInput) -> tuple[list[dict], list[dict]]:
    """Validated models → the JSON columns, with ids and positions preserved."""
    return (
        [node.model_dump(mode="json") for node in payload.nodes],
        [edge.model_dump(mode="json") for edge in payload.edges],
    )


def columns_to_graph(row: Workflow) -> tuple[list[Node], list[Edge]]:
    """JSON columns → validated models, for the engine and the validator."""
    return (
        [Node.model_validate(node) for node in row.nodes],
        [Edge.model_validate(edge) for edge in row.edges],
    )


# ── Registry metadata ───────────────────────────────────────────────────────


class ToolMeta(BaseModel):
    id: str
    name: str
    description: str
    input_schema: dict[str, Any]


class ProviderMeta(BaseModel):
    id: str
    label: str
    models: list[str]


# ── Running ─────────────────────────────────────────────────────────────────


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class RunRequest(BaseModel):
    message: str = Field(min_length=1)
    history: list[ChatTurn] = Field(default_factory=list)


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class RunResponse(BaseModel):
    run_id: str
    final_response: str
    # Typed rather than `list[dict]` so the envelope is described in the
    # published OpenAPI — it is the most important type in the contract, and
    # `npm run gen:api` should hand the frontend real types for it.
    events: list[RunEvent]
    usage: Usage
    duration_ms: int


class RunSummary(BaseModel):
    run_id: str
    user_message: str
    final_response: str
    created_at: datetime
    usage: Usage
    duration_ms: int


class SentEmailRead(BaseModel):
    id: str
    to: str
    subject: str
    body: str
    run_id: str | None
    created_at: datetime
