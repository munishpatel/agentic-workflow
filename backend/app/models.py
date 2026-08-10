from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import Column
from sqlalchemy.types import JSON
from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(UTC)


def _wf_id() -> str:
    return f"wf_{uuid4().hex}"


def _run_id() -> str:
    return f"run_{uuid4().hex}"


def _email_id() -> str:
    return f"eml_{uuid4().hex}"


class Workflow(SQLModel, table=True):
    """
    `nodes` and `edges` are JSON columns: a graph is always read and written
    whole, nothing queries inside one, and JSON keeps the migration surface
    small while the shape is still settling.

    They are stored as `dict`, but the engine only ever sees validated Pydantic
    `Node`/`Edge` models — parsing happens at the boundary in `schemas.py`.
    That is what stops "some dict somewhere has the wrong shape" from reaching
    the scheduler.
    """

    id: str = Field(default_factory=_wf_id, primary_key=True)
    name: str
    description: str | None = None
    provider: str = "anthropic"
    model: str = "claude-opus-5"
    system_prompt: str = ""
    nodes: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    edges: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Run(SQLModel, table=True):
    """Persisting the full event log is the execution-history feature, for free."""

    id: str = Field(default_factory=_run_id, primary_key=True)
    workflow_id: str = Field(index=True, foreign_key="workflow.id")
    user_message: str
    final_response: str = ""
    status: str = "ok"  # "ok" | "error" | "paused"
    events: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    # Set only while `status == "paused"`: the frozen run, waiting on a human
    # verdict for a gated tool call. Cleared once the run finishes, because a
    # finished run must not be resumable — the outbox is not an undo stack.
    checkpoint: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0
    created_at: datetime = Field(default_factory=_now)


class SentEmail(SQLModel, table=True):
    """The mock outbox. `send_email` writes here and sends nothing."""

    id: str = Field(default_factory=_email_id, primary_key=True)
    to: str
    subject: str
    body: str
    run_id: str | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=_now)
