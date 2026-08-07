import logging
import time
from uuid import uuid4

from app.engine.events import EventBus
from app.engine.scheduler import run_graph
from app.errors import AppError, RunError
from app.graph.types import Edge, Node
from app.llm.base import LLMProvider, Usage
from app.llm.errors import AuthError, LLMError, RateLimitError
from app.tools.base import ToolContext

logger = logging.getLogger("app.engine.runner")


class RunResult:
    __slots__ = ("duration_ms", "events", "final_response", "run_id", "status", "usage")

    def __init__(
        self,
        run_id: str,
        final_response: str,
        events: list[dict],
        usage: Usage,
        duration_ms: int,
        status: str,
    ) -> None:
        self.run_id = run_id
        self.final_response = final_response
        self.events = events
        self.usage = usage
        self.duration_ms = duration_ms
        self.status = status


async def execute_run(
    *,
    nodes: list[Node],
    edges: list[Edge],
    workflow_id: str,
    workflow_name: str,
    system_prompt: str,
    model: str,
    provider: LLMProvider,
    message: str,
    history: list[dict[str, str]],
    tool_ctx: ToolContext,
) -> RunResult:
    """
    Where the failure happens decides the shape.

    Once the run has started, a failure returns **HTTP 200** with a normal
    RunResponse whose event log ends in `run.error` — because the partial
    timeline (which nodes ran, which tools were called, where it died) is
    exactly what the user needs, and a 500 would discard all of it. Errors
    *before* the run starts (missing credential, unknown workflow, invalid
    graph) never reach here; they are raised as `AppError` and mapped to a
    status by FastAPI.
    """
    run_id = f"run_{uuid4().hex}"
    bus = EventBus(run_id)
    tool_ctx.run_id = run_id
    started = time.perf_counter()

    try:
        outcome = await run_graph(
            nodes=nodes,
            edges=edges,
            workflow_name=workflow_name,
            workflow_id=workflow_id,
            system_prompt=system_prompt,
            model=model,
            provider=provider,
            message=message,
            history=history,
            bus=bus,
            tool_ctx=tool_ctx,
        )
    except RunError as exc:
        return _failed(bus, run_id, exc.code, exc.message, started, getattr(exc, "details", None))
    except AppError:
        # A pre-run failure — validation rejects the graph before `run.start`
        # is even emitted, so there is no timeline worth returning. Let it
        # propagate and become an HTTP error with its own status.
        raise
    except LLMError as exc:
        code = (
            "rate_limit"
            if isinstance(exc, RateLimitError)
            else "provider_auth"
            if isinstance(exc, AuthError)
            else "provider_unavailable"
        )
        return _failed(bus, run_id, code, exc.message, started)
    except Exception as exc:
        logger.exception("Run %s crashed", run_id)
        return _failed(bus, run_id, "internal_error", f"The run failed: {exc}", started)

    # `run.end` must agree with the top-level RunResponse fields — the UI takes
    # the message from one and the timeline from the other.
    bus.emit(
        "run.end",
        {
            "final_response": outcome.final_response,
            "usage": outcome.usage.model_dump(),
            "duration_ms": outcome.duration_ms,
        },
    )
    return RunResult(
        run_id=run_id,
        final_response=outcome.final_response,
        events=bus.dump(),
        usage=outcome.usage,
        duration_ms=outcome.duration_ms,
        status="ok",
    )


def usage_from_events(bus: EventBus) -> Usage:
    """
    Sum the per-iteration usage the `llm.response` events already carry.

    Deriving rather than threading a second accumulator keeps one source of
    truth: what the run reports and what the timeline shows cannot diverge.
    """
    total = Usage()
    for event in bus.events:
        if event.type != "llm.response":
            continue
        reported = event.payload.get("usage") or {}
        total = total + Usage(
            input_tokens=int(reported.get("input_tokens", 0) or 0),
            output_tokens=int(reported.get("output_tokens", 0) or 0),
        )
    return total


def _failed(
    bus: EventBus,
    run_id: str,
    code: str,
    message: str,
    started: float,
    details: object = None,
) -> RunResult:
    payload: dict[str, object] = {"code": code, "message": message}
    node_id = None
    if isinstance(details, dict):
        node_id = details.get("node_id")
    if node_id:
        payload["node_id"] = node_id
    # A failed run MUST emit run.error, or the UI shows a permanent spinner on
    # the node it died in.
    bus.emit("run.error", payload)
    return RunResult(
        run_id=run_id,
        final_response="",
        events=bus.dump(),
        # Tokens spent before the failure were still spent and still billed —
        # reporting zero here under-counts the user's session totals. The
        # scheduler's running total is lost with the exception, so it is derived
        # from the event log, which is the same thing the timeline shows.
        usage=usage_from_events(bus),
        duration_ms=int((time.perf_counter() - started) * 1000),
        status="error",
    )
