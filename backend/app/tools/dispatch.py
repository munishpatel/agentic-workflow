import asyncio
import logging
import time
from typing import Any

from pydantic import ValidationError

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import get_tool

logger = logging.getLogger("app.tools.dispatch")

TOOL_TIMEOUT_SECONDS = 20


def _timeout_for(tool: Any) -> int:
    """
    A tool may declare `timeout_seconds` to widen the default.

    Only one needs it: `web_search` falling back to Anthropic's server-side
    search runs several queries inside one call, so it legitimately outlives a
    budget sized for a single HTTP request. Keeping the default tight and making
    the exception opt-in is safer than raising the cap for every tool.
    """
    declared = getattr(tool, "timeout_seconds", None)
    return declared if isinstance(declared, int) and declared > 0 else TOOL_TIMEOUT_SECONDS


class DispatchOutcome:
    """A `ToolResult` plus how long it took, which the timeline shows."""

    __slots__ = ("ms", "result")

    def __init__(self, result: ToolResult, ms: int) -> None:
        self.result = result
        self.ms = ms


async def dispatch(tool_id: str, raw_args: dict[str, Any], ctx: ToolContext) -> DispatchOutcome:
    """
    The safety layer. **This function never raises.**

    A failing tool must never abort the agent loop: the model gets a
    `tool_result` with `is_error=True` and a chance to recover. Every failure
    mode below turns into that, and every dispatch is timed.
    """
    started = time.perf_counter()

    def finish(result: ToolResult) -> DispatchOutcome:
        return DispatchOutcome(result, int((time.perf_counter() - started) * 1000))

    tool = get_tool(tool_id)
    if tool is None:
        return finish(ToolResult(output=f"There is no tool called “{tool_id}”.", is_error=True))

    try:
        args = tool.Input.model_validate(raw_args)
    except ValidationError as exc:
        # Pydantic's own message goes back to the model verbatim — it names the
        # offending field, which is exactly what it needs to retry correctly.
        return finish(ToolResult(output=f"Invalid arguments for {tool_id}: {exc}", is_error=True))

    budget = _timeout_for(tool)
    try:
        async with asyncio.timeout(budget):
            result = await tool.execute(args, ctx)
    except TimeoutError:
        return finish(
            ToolResult(output=f"{tool_id} timed out after {budget} seconds.", is_error=True)
        )
    except asyncio.CancelledError:
        # A cancelled run is not a tool failure — let it propagate.
        raise
    except Exception as exc:
        logger.exception("Tool %s raised", tool_id)
        return finish(ToolResult(output=f"{tool_id} failed: {exc}", is_error=True))

    if not isinstance(result, ToolResult):
        return finish(ToolResult(output=f"{tool_id} returned an unexpected value.", is_error=True))
    return finish(result)
