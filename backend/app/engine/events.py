import time
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

RunEventType = Literal[
    "run.start",
    "run.end",
    "run.error",
    "node.start",
    "node.end",
    "node.skipped",
    "edge.transfer",
    "llm.request",
    "llm.response",
    "text.delta",
    "text.message",
    "tool.call",
    "tool.result",
    "route.decision",
    # A gated tool call stopped the run here, and this is the call a human is
    # being asked about. The matching `tool.result` only ever arrives after an
    # `approval.decision` — which is what makes "nothing ran unreviewed"
    # readable straight off the log rather than taken on trust.
    "approval.required",
    "approval.decision",
]

PREVIEW_LIMIT = 200


class RunEvent(BaseModel):
    """
    One envelope for everything observable in a run.

    There is deliberately no per-concern event type. That is what makes the
    whole observability story an ordered append-only log, and what makes
    streaming an additive change later: the same envelopes over SSE feed the
    same reducer the frontend already ships.
    """

    id: str
    run_id: str
    # Monotonic total order within a run. The frontend sorts by this and never
    # by `ts` — timestamps tie.
    seq: int
    ts: float
    author: Literal["user", "system", "node"] = "system"
    node_id: str | None = None
    # Sub-workflow nesting path; unused in v1, but the hook is in the envelope
    # so adding sub-workflows needs no contract change.
    branch: str | None = None
    type: RunEventType
    payload: dict[str, Any] = Field(default_factory=dict)
    partial: bool = False
    final: bool = True


def truncate_preview(value: Any) -> str:
    """`edge.transfer.preview` — a short string form of whatever crossed."""
    text = value if isinstance(value, str) else str(value)
    if len(text) <= PREVIEW_LIMIT:
        return text
    return text[:PREVIEW_LIMIT] + "…"


class EventBus:
    """
    A sequence counter, one `emit`, and a list sink persisted to `Run.events`.

    `emit` is the **only** place `seq` is assigned, and it assigns it
    synchronously with no `await` between read and increment. That matters:
    nodes run concurrently under `asyncio.gather`, and a duplicated `seq`
    breaks the frontend's ordering.
    """

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._seq = 0
        self.events: list[RunEvent] = []

    @classmethod
    def restore(cls, run_id: str, events: list[dict[str, Any]]) -> "EventBus":
        """
        A bus that continues a run rather than starting one.

        A run that pauses for approval and resumes is **one** run with one
        timeline, so the second segment appends to the first and `seq` picks up
        where it left off. Rebuilding from `max(seq) + 1` rather than `len` is
        deliberate: a malformed stored log should still yield ids that sort
        after everything already in it.
        """
        bus = cls(run_id)
        bus.events = [RunEvent.model_validate(event) for event in events]
        bus._seq = max((event.seq for event in bus.events), default=-1) + 1
        return bus

    def emit(
        self,
        event_type: RunEventType,
        payload: dict[str, Any] | None = None,
        *,
        node_id: str | None = None,
        author: Literal["user", "system", "node"] | None = None,
        partial: bool = False,
        final: bool = True,
    ) -> RunEvent:
        seq = self._seq
        self._seq += 1  # synchronous — no await may appear between these lines
        event = RunEvent(
            id=f"ev_{uuid4().hex[:16]}",
            run_id=self.run_id,
            seq=seq,
            ts=time.time(),
            author=author or ("node" if node_id else "system"),
            node_id=node_id,
            type=event_type,
            payload=payload or {},
            partial=partial,
            final=final,
        )
        self.events.append(event)
        return event

    def dump(self) -> list[dict[str, Any]]:
        """JSON-ready, for `Run.events` and the API response."""
        return [event.model_dump(mode="json", exclude_none=False) for event in self.events]
