"""
A paused run, frozen whole.

The engine executes a run inside a single request, so "wait for a human" cannot
mean "block". It means: stop at the gated call, write down everything needed to
carry on, and return. `POST /api/runs/{id}/resume` reads that back and finishes
the job.

Everything here is a Pydantic model with JSON-safe fields, because a checkpoint
is stored in a JSON column and has to survive a server restart. Nothing in it is
a handle to a live object — no provider, no session, no event bus. Those are
supplied fresh by whichever request resumes the run.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.graph.types import Edge, Node
from app.llm.base import LLMMessage, Usage


class PendingCall(BaseModel):
    """A gated tool call that is waiting on a verdict."""

    call_id: str
    node_id: str
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)


class SettledCall(BaseModel):
    """
    A tool result already in hand at the moment the run paused.

    The ungated calls from the same model turn are dispatched immediately rather
    than held — a `web_search` alongside a `send_email` is not made safer by
    waiting, and running it now saves a round trip on resume.
    """

    call_id: str
    output: str
    is_error: bool = False
    ms: int = 0


class ApprovalDecision(BaseModel):
    """One human verdict. `note` is passed to the model, so it is user-facing."""

    call_id: str
    approved: bool
    note: str = ""


class LoopCheckpoint(BaseModel):
    """
    Enough of `run_agent_loop`'s locals to re-enter it mid-iteration.

    `order` is not decoration: the protocol requires every tool result for a
    turn in one user message, and the model's own call order is the order they
    have to appear in. Settled and pending results are merged back into it on
    resume, which is why it is captured rather than recomputed.
    """

    iteration: int
    messages: list[LLMMessage]
    usage: Usage = Field(default_factory=Usage)
    order: list[str]
    settled: list[SettledCall] = Field(default_factory=list)
    pending: list[PendingCall] = Field(default_factory=list)


class NodePause(BaseModel):
    """
    One node stopped at a gate.

    Agent nodes carry a whole `loop`; tool nodes are a single dispatch and carry
    just the `call`. `pending_calls` is what everything above this layer reads,
    so neither shape leaks into the API or the scheduler.
    """

    node_id: str
    kind: Literal["agent", "tool"]
    loop: LoopCheckpoint | None = None
    call: PendingCall | None = None

    @property
    def pending_calls(self) -> list[PendingCall]:
        if self.loop is not None:
            return self.loop.pending
        return [self.call] if self.call is not None else []


class RunCheckpoint(BaseModel):
    """
    The run's inputs and the scheduler's state, at the moment it paused.

    The graph is **copied in** rather than re-read from the workflow on resume.
    A verdict approves *this* call in *this* run; if the workflow were re-read,
    editing it while the approval sat waiting would change what the click
    actually executes — which is the one thing an approval gate must never do.
    """

    workflow_id: str
    workflow_name: str
    provider_id: str
    model: str
    system_prompt: str
    message: str
    history: list[dict[str, str]] = Field(default_factory=list)
    nodes: list[Node]
    edges: list[Edge]

    # ── Scheduler state ──────────────────────────────────────────────────────
    # `values` is keyed by (node_id, port) in the scheduler; JSON has no tuple
    # keys, so it is stored as a list of triples and rebuilt on the way in.
    values: list[tuple[str, str, Any]] = Field(default_factory=list)
    done: list[str] = Field(default_factory=list)
    pruned: list[str] = Field(default_factory=list)
    executions: int = 0
    usage: Usage = Field(default_factory=Usage)
    final_response: str | None = None
    elapsed_ms: int = 0

    paused: list[NodePause] = Field(default_factory=list)

    @property
    def pending_calls(self) -> list[PendingCall]:
        return [call for pause in self.paused for call in pause.pending_calls]


# ── Control-flow signals ────────────────────────────────────────────────────
# Exceptions rather than return values: a gated call is found deep inside the
# tool-use loop, and unwinding to the scheduler through five layers of return
# type would put `| None` on every one of them. These are caught in exactly two
# places (`_execute` and `run_graph`) and never escape the engine.


class LoopPaused(Exception):
    """Raised by `run_agent_loop` when a gated call needs a verdict."""

    def __init__(self, checkpoint: LoopCheckpoint) -> None:
        super().__init__("The agent loop is waiting on a human decision.")
        self.checkpoint = checkpoint


class NodePaused(Exception):
    """Raised by `_execute` so `run_graph` can checkpoint the whole run."""

    def __init__(self, pause: NodePause) -> None:
        super().__init__(f"Node {pause.node_id} is waiting on a human decision.")
        self.pause = pause
