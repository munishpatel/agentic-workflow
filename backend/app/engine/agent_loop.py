import asyncio
import logging

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
from app.tools.base import ToolContext
from app.tools.dispatch import dispatch
from app.tools.registry import tool_schemas

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
    """
    messages: list[LLMMessage] = [
        *history,
        LLMMessage(role="user", content=[TextContent(text=prompt)]),
    ]
    schemas = [ToolSchema(**schema) for schema in tool_schemas(tool_ids)]
    total = Usage()

    for iteration in range(1, max_iterations + 1):
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

        outcomes = await asyncio.gather(
            *(dispatch(call.tool, call.input, tool_ctx) for call in calls)
        )

        results: list[ToolResultContent] = []
        for call, outcome in zip(calls, outcomes, strict=True):
            bus.emit(
                "tool.result",
                {
                    "call_id": call.id,
                    "tool": call.tool,
                    "output": outcome.result.output,
                    "is_error": outcome.result.is_error,
                    "ms": outcome.ms,
                },
                node_id=node_id,
            )
            # Rule 3: one result per call, including the failures.
            results.append(
                ToolResultContent(
                    call_id=call.id,
                    output=outcome.result.output,
                    is_error=outcome.result.is_error,
                )
            )

        # Rule 2: every result in a single user turn.
        messages.append(LLMMessage(role="user", content=list(results)))

    raise IterationLimitError(
        f"This agent reached its limit of {max_iterations} tool iterations without finishing. "
        "Raise “max tool iterations” on the node, or narrow its instruction."
    )


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
