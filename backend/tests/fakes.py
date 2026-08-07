import json
from collections.abc import Callable

from app.llm.base import (
    LLMRequest,
    LLMResponse,
    TextContent,
    ToolCallContent,
    Usage,
)


class FakeProvider:
    """
    A scripted provider. Every engine test runs against this — the wire format
    itself is covered by the respx tests, so the engine tests can stay about
    scheduling and control flow.
    """

    id = "fake"

    def __init__(self, responses: list[LLMResponse] | Callable[[LLMRequest], LLMResponse]):
        self._responses = responses
        self.requests: list[LLMRequest] = []
        self._index = 0

    async def send(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        if callable(self._responses):
            return self._responses(request)
        if self._index >= len(self._responses):
            # Running off the end of the script means the loop iterated more
            # than the test expected — say so loudly.
            raise AssertionError(f"FakeProvider ran out of scripted responses after {self._index}")
        response = self._responses[self._index]
        self._index += 1
        return response

    async def aclose(self) -> None:
        return None


def text_response(text: str, *, input_tokens: int = 10, output_tokens: int = 5) -> LLMResponse:
    return LLMResponse(
        content=[TextContent(text=text)],
        stop_reason="end",
        usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens),
    )


def tool_call_response(
    tool: str, args: dict, *, call_id: str = "toolu_1", text: str = ""
) -> LLMResponse:
    content = [TextContent(text=text)] if text else []
    content.append(ToolCallContent(id=call_id, tool=tool, input=args))
    return LLMResponse(
        content=content,
        stop_reason="tool_call",
        usage=Usage(input_tokens=20, output_tokens=8),
    )


def refusal_response() -> LLMResponse:
    """HTTP 200, empty content — the shape that crashes naive `content[0]` code."""
    return LLMResponse(
        content=[],
        stop_reason="refusal",
        usage=Usage(input_tokens=15, output_tokens=0),
        refusal_category="cyber",
    )


def route_response(label: str, reason: str = "because") -> LLMResponse:
    """Structured output — the router parses this as JSON, not prose."""
    return text_response(json.dumps({"label": label, "reason": reason}))


def routing_provider(chosen: str, then: list[LLMResponse] | None = None) -> FakeProvider:
    """
    A provider that answers the router first and then plays the remaining
    script, which is the order the branching graph asks in.
    """
    return FakeProvider([route_response(chosen), *(then or [])])
