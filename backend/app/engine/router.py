import json
import logging

from app.engine.events import EventBus
from app.graph.kinds import RouterConfig
from app.llm.base import LLMMessage, LLMProvider, LLMRequest, TextContent, Usage

logger = logging.getLogger("app.engine.router")


class RouteDecision:
    __slots__ = ("chosen", "reason", "usage")

    def __init__(self, chosen: str, reason: str, usage: Usage) -> None:
        self.chosen = chosen
        self.reason = reason
        self.usage = usage


def decision_schema(labels: list[str]) -> dict[str, object]:
    """
    Structured output, not JSON scraped out of prose. `label` is constrained to
    the configured routes, so the model cannot invent a branch.
    """
    return {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "enum": labels},
                "reason": {"type": "string"},
            },
            "required": ["label", "reason"],
            "additionalProperties": False,
        },
    }


async def decide_route(
    *,
    provider: LLMProvider,
    model: str,
    system: str,
    config: RouterConfig,
    value: str,
    bus: EventBus,
    node_id: str,
    label: str,
) -> RouteDecision:
    routes = [route for route in config.routes if route.label]
    labels = [route.label for route in routes]
    described = "\n".join(f"- {route.label}: {route.description}" for route in routes)

    instruction = (
        f"## Current step: {label}\n"
        "Classify the input into exactly one of these routes and explain the choice "
        "in one sentence:\n"
        f"{described}"
    )
    composed = f"{system.strip()}\n\n{instruction}" if system.strip() else instruction

    bus.emit(
        "llm.request",
        {"iteration": 1, "model": model, "tool_count": 0},
        node_id=node_id,
    )
    response = await provider.send(
        LLMRequest(
            model=model,
            system=composed,
            messages=[LLMMessage(role="user", content=[TextContent(text=value)])],
            response_format=decision_schema(labels),
            effort="low",
        )
    )
    bus.emit(
        "llm.response",
        {
            "iteration": 1,
            "usage": response.usage.model_dump(),
            "stop_reason": response.stop_reason,
        },
        node_id=node_id,
    )

    chosen, reason = _parse(response.text, labels)
    bus.emit(
        "route.decision",
        {"chosen": chosen, "reason": reason, "considered": labels},
        node_id=node_id,
    )
    return RouteDecision(chosen, reason, response.usage)


def _parse(text: str, labels: list[str]) -> tuple[str, str]:
    """
    Never crash on model output. Structured output makes a well-formed answer
    overwhelmingly likely, but a malformed one falls back to the first route
    with the reason saying so — a router that raises would take the whole run
    down over a formatting slip.
    """
    fallback = labels[0] if labels else ""
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        logger.warning("Router returned unparseable output; falling back to %r", fallback)
        return fallback, "The classifier did not return a usable decision; took the first route."

    if not isinstance(parsed, dict):
        return fallback, "The classifier did not return a usable decision; took the first route."

    chosen = parsed.get("label")
    reason = str(parsed.get("reason") or "").strip()
    if chosen not in labels:
        logger.warning("Router chose unknown route %r; falling back to %r", chosen, fallback)
        return fallback, (
            f"The classifier chose “{chosen}”, which is not a configured route; "
            "took the first route instead."
        )
    return chosen, reason or "No reason given."
