import asyncio
import logging

from app.engine.checkpoint import (
    ApprovalDecision,
    LoopCheckpoint,
    LoopPaused,
    PendingCall,
    SettledCall,
)
from app.engine.events import EventBus
from app.errors import IterationLimitError, RefusalError
from app.llm.base import (
    LLMMessage,
    LLMProvider,
    LLMRequest,
    TextContent,
    ToolCallContent,
    ToolResultContent,
    ToolSchema,
    Usage,
)
from app.tools.base import ToolContext, ToolResult
from app.tools.dispatch import dispatch
from app.tools.registry import requires_approval, tool_schemas

logger = logging.getLogger("app.engine.agent_loop")


class AgentTurn:
    """What one agent node produced."""

    __slots__ = ("text", "usage")

    def __init__(self, text: str, usage: Usage) -> None:
        self.text = text
        self.usage = usage


async def run_agent_loop(
    *,
    provider: LLMProvider,
    model: str,
    system: str,
    prompt: str,
    history: list[LLMMessage],
    tool_ids: list[str],
    max_iterations: int,
    bus: EventBus,
    node_id: str,
    tool_ctx: ToolContext,
    resume: LoopCheckpoint | None = None,
    decisions: dict[str, ApprovalDecision] | None = None,
) -> AgentTurn:
    """
    The tool-use loop, hand-written.

    Three protocol rules are easy to get wrong and each produces a confusing
    failure — they are the reason this is written out rather than delegated:

      1. Append the assistant's **full** content, tool-call blocks included.
         Dropping them leaves the next request with a `tool_result` that has no
         matching `tool_use`, which is a 400.
      2. **All** tool results for a turn go in **one** user message. Splitting
         them across messages trains the model out of parallel tool calls.
      3. Every `tool_call` needs exactly one `tool_result` with the same id —
         **including failures**. A missing one is a 400.

    Pass `resume` to re-enter the loop where a gated tool call stopped it. The
    three rules are exactly why resuming rebuilds the results message rather
    than appending a second one: from the model's side a run that waited an hour
    for a human is indistinguishable from one that did not wait at all.
    """
    schemas = [ToolSchema(**schema) for schema in tool_schemas(tool_ids)]

    if resume is None:
        messages: list[LLMMessage] = [
            *history,
            LLMMessage(role="user", content=[TextContent(text=prompt)]),
        ]
        total = Usage()
        first_iteration = 1
    else:
        messages = list(resume.messages)
        total = resume.usage
        # Rule 2 again: one user message carrying every result for the turn,
        # the approved and rejected ones interleaved back into the model's own
        # call order.
        messages.append(
            LLMMessage(
                role="user",
                content=await _settle(resume, decisions or {}, bus, node_id, tool_ctx),
            )
        )
        first_iteration = resume.iteration + 1
        if first_iteration > max_iterations:
            raise IterationLimitError(
                f"This agent reached its limit of {max_iterations} tool iterations while "
                "resuming from an approval. Raise “max tool iterations” on the node."
            )

    for iteration in range(first_iteration, max_iterations + 1):
        bus.emit(
            "llm.request",
            {"iteration": iteration, "model": model, "tool_count": len(schemas)},
            node_id=node_id,
        )

        response = await provider.send(
            LLMRequest(
                model=model,
                system=system,
                messages=messages,
                tools=schemas,
            )
        )
        total = total + response.usage

        bus.emit(
            "llm.response",
            {
                "iteration": iteration,
                "usage": response.usage.model_dump(),
                "stop_reason": response.stop_reason,
            },
            node_id=node_id,
        )

        # Checked before touching `content` — a refusal is an HTTP 200 whose
        # content may be empty, so indexing it blindly is a crash.
        if response.stop_reason == "refusal":
            raise RefusalError(
                "The model declined to respond to this request"
                + (f" ({response.refusal_category})." if response.refusal_category else ".")
            )

        # Rule 1: the assistant's full content, tool calls and all.
        messages.append(LLMMessage(role="assistant", content=response.content))

        text = response.text
        if text:
            bus.emit("text.message", {"text": text}, node_id=node_id, final=True)

        if response.stop_reason == "max_tokens":
            # Half an answer is worth surfacing rather than discarding, but the
            # user needs to know it was cut off.
            logger.warning("Agent node %s hit max_tokens on iteration %s", node_id, iteration)
            return AgentTurn(text, total)

        calls = response.tool_calls
        if not calls:
            return AgentTurn(text, total)

        for call in calls:
            bus.emit(
                "tool.call",
                {"call_id": call.id, "tool": call.tool, "input": call.input},
                node_id=node_id,
            )

        # Gated calls are held; their ungated siblings from the same turn are
        # dispatched now. Holding a `web_search` hostage to an unrelated
        # `send_email` protects nothing and costs a round trip on resume.
        gated_ids = {call.id for call in calls if requires_approval(call.tool)}
        ungated = [call for call in calls if call.id not in gated_ids]

        outcomes = await asyncio.gather(
            *(dispatch(call.tool, call.input, tool_ctx) for call in ungated)
        )
        settled = [
            _record(call, outcome.result, outcome.ms, bus, node_id)
            for call, outcome in zip(ungated, outcomes, strict=True)
        ]

        if gated_ids:
            pending = [
                PendingCall(call_id=call.id, node_id=node_id, tool=call.tool, input=call.input)
                for call in calls
                if call.id in gated_ids
            ]
            for call in pending:
                bus.emit(
                    "approval.required",
                    {"call_id": call.call_id, "tool": call.tool, "input": call.input},
                    node_id=node_id,
                )
            raise LoopPaused(
                LoopCheckpoint(
                    iteration=iteration,
                    messages=messages,
                    usage=total,
                    order=[call.id for call in calls],
                    settled=settled,
                    pending=pending,
                )
            )

        # Rule 2: every result in a single user turn.
        messages.append(
            LLMMessage(role="user", content=_results_in_order([call.id for call in calls], settled))
        )

    raise IterationLimitError(
        f"This agent reached its limit of {max_iterations} tool iterations without finishing. "
        "Raise “max tool iterations” on the node, or narrow its instruction."
    )


def _record(
    call: ToolCallContent | PendingCall,
    result: ToolResult,
    ms: int,
    bus: EventBus,
    node_id: str,
) -> SettledCall:
    """Emit the `tool.result` and keep the record a checkpoint would need."""
    call_id = call.id if isinstance(call, ToolCallContent) else call.call_id
    bus.emit(
        "tool.result",
        {
            "call_id": call_id,
            "tool": call.tool,
            "output": result.output,
            "is_error": result.is_error,
            "ms": ms,
        },
        node_id=node_id,
    )
    return SettledCall(call_id=call_id, output=result.output, is_error=result.is_error, ms=ms)


def _results_in_order(order: list[str], settled: list[SettledCall]) -> list[ToolResultContent]:
    """
    Rule 3, restated for the resume path: one result per call, in the order the
    model asked for them. Results arrive out of order here — the ungated ones
    were dispatched before the pause and the gated ones long after — so `order`
    is what puts them back.
    """
    by_id = {record.call_id: record for record in settled}
    return [
        ToolResultContent(
            call_id=call_id,
            output=by_id[call_id].output,
            is_error=by_id[call_id].is_error,
        )
        for call_id in order
        if call_id in by_id
    ]


def rejection_result(tool: str, note: str) -> ToolResult:
    """
    What a rejected call tells the model.

    Marked `is_error` so the model treats it as an action that did not happen,
    and worded to stop the obvious failure mode — retrying the same call with
    the same arguments, which would just queue a second approval.
    """
    text = f"A human reviewer rejected this {tool} call, so it did not run."
    if note.strip():
        text += f" Their note: {note.strip()}"
    text += (
        " Do not call it again with the same arguments. Tell the user the action was declined "
        "and, if there is one, what the reviewer said."
    )
    return ToolResult(output=text, is_error=True)


async def _settle(
    resume: LoopCheckpoint,
    decisions: dict[str, ApprovalDecision],
    bus: EventBus,
    node_id: str,
    tool_ctx: ToolContext,
) -> list[ToolResultContent]:
    """
    Turn the held calls into results, then merge them with the ones that were
    already settled before the pause.

    A call with no decision is treated as rejected. The API rejects an
    incomplete resume request before it reaches here, so this is the belt to
    that braces — and defaulting to "did not run" is the only safe direction
    for a gate whose entire job is to withhold consent.
    """
    settled = list(resume.settled)
    for call in resume.pending:
        decision = decisions.get(call.call_id)
        approved = decision is not None and decision.approved
        note = decision.note if decision is not None else ""
        bus.emit(
            "approval.decision",
            {
                "call_id": call.call_id,
                "tool": call.tool,
                "approved": approved,
                "note": note,
            },
            node_id=node_id,
        )
        if approved:
            outcome = await dispatch(call.tool, call.input, tool_ctx)
            settled.append(_record(call, outcome.result, outcome.ms, bus, node_id))
        else:
            settled.append(_record(call, rejection_result(call.tool, note), 0, bus, node_id))
    return _results_in_order(resume.order, settled)


def compose_system_prompt(workflow_system_prompt: str, label: str, instruction: str) -> str:
    """
    Persona is graph-wide, task is node-local — the workflow's system prompt
    plus this node's step. Composing rather than replacing is what lets one
    persona span a whole graph.
    """
    parts = [workflow_system_prompt.strip()] if workflow_system_prompt.strip() else []
    step = instruction.strip()
    if step:
        parts.append(f"## Current step: {label}\n{step}")
    elif label:
        parts.append(f"## Current step: {label}")
    return "\n\n".join(parts)


def build_history(turns: list[dict[str, str]]) -> list[LLMMessage]:
    """Prior chat turns → provider messages. Anything malformed is skipped."""
    messages: list[LLMMessage] = []
    for turn in turns:
        role = turn.get("role")
        content = turn.get("content") or ""
        if role in ("user", "assistant") and content:
            messages.append(LLMMessage(role=role, content=[TextContent(text=content)]))
    return messages


def as_tool_call(call: ToolCallContent) -> dict[str, object]:
    return {"call_id": call.id, "tool": call.tool, "input": call.input}
