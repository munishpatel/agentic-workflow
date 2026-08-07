import asyncio
import logging
import random
from typing import Any

import httpx

from app.llm.base import (
    LLMContent,
    LLMRequest,
    LLMResponse,
    StopReason,
    TextContent,
    ToolCallContent,
    ToolResultContent,
    Usage,
)
from app.llm.errors import (
    AuthError,
    BadRequestError,
    LLMError,
    NetworkError,
    ProviderServerError,
    RateLimitError,
)

logger = logging.getLogger("app.llm.anthropic")

ANTHROPIC_VERSION = "2023-06-01"
MAX_ATTEMPTS = 3
RETRY_STATUSES = {429, 500, 502, 503, 504, 529}


# ── Block mapping ───────────────────────────────────────────────────────────
# Two pure functions, extracted so they are unit-testable without HTTP. This
# mapping is precisely what an SDK hides, and it is the part most likely to be
# subtly wrong, so it gets tested on its own.


def _to_wire(request: LLMRequest) -> dict[str, Any]:
    """Our vocabulary → the Anthropic Messages API body."""
    messages: list[dict[str, Any]] = []
    for message in request.messages:
        blocks: list[dict[str, Any]] = []
        for block in message.content:
            if isinstance(block, TextContent):
                blocks.append({"type": "text", "text": block.text})
            elif isinstance(block, ToolCallContent):
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.tool,
                        "input": block.input,
                    }
                )
            elif isinstance(block, ToolResultContent):
                blocks.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.call_id,
                        "content": block.output,
                        "is_error": block.is_error,
                    }
                )
        messages.append({"role": message.role, "content": blocks})

    body: dict[str, Any] = {
        "model": request.model,
        # Thinking is on by default on claude-opus-5 and shares this budget.
        "max_tokens": request.max_tokens,
        "messages": messages,
        # Adaptive is equivalent to the default on this model; sending it
        # explicitly documents the intent and works on the 4.7/4.8 family too.
        "thinking": {"type": "adaptive"},
    }

    # NOTE: temperature / top_p / top_k / budget_tokens are deliberately never
    # sent — claude-opus-5 returns 400 for every one of them. Steering happens
    # through the prompt and `effort`.

    if request.system:
        body["system"] = request.system

    output_config: dict[str, Any] = {}
    if request.effort:
        output_config["effort"] = request.effort
    if request.response_format:
        # Structured output for router decisions — a parsed field, never JSON
        # scraped out of prose.
        output_config["format"] = request.response_format
    if output_config:
        body["output_config"] = output_config

    if request.tools:
        body["tools"] = [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }
            for tool in request.tools
        ]

    return body


_STOP_REASONS: dict[str, StopReason] = {
    "end_turn": "end",
    "stop_sequence": "end",
    "tool_use": "tool_call",
    "max_tokens": "max_tokens",
    "refusal": "refusal",
}


def _from_wire(payload: dict[str, Any]) -> LLMResponse:
    """The Anthropic response → our vocabulary."""
    raw_stop = payload.get("stop_reason") or "end_turn"
    stop_reason = _STOP_REASONS.get(raw_stop, "end")

    content: list[LLMContent] = []
    for block in payload.get("content") or []:
        block_type = block.get("type")
        if block_type == "text":
            content.append(TextContent(text=block.get("text", "")))
        elif block_type == "tool_use":
            content.append(
                ToolCallContent(
                    id=block.get("id", ""),
                    tool=block.get("name", ""),
                    input=block.get("input") or {},
                )
            )
        # `thinking` blocks arrive with empty text (display defaults to
        # "omitted") and carry nothing we surface, so they are skipped rather
        # than mapped. Any other block type is ignored the same way: an
        # unfamiliar block should never break a run.

    raw_usage = payload.get("usage") or {}
    usage = Usage(
        input_tokens=raw_usage.get("input_tokens", 0) or 0,
        output_tokens=raw_usage.get("output_tokens", 0) or 0,
    )

    stop_details = payload.get("stop_details") or {}
    return LLMResponse(
        content=content,
        stop_reason=stop_reason,
        usage=usage,
        refusal_category=stop_details.get("category") if stop_reason == "refusal" else None,
    )


# ── HTTP layer ──────────────────────────────────────────────────────────────


def _map_status(status: int, body: dict[str, Any] | None) -> LLMError:
    detail = ""
    if isinstance(body, dict):
        detail = (body.get("error") or {}).get("message", "") or ""
    suffix = f": {detail}" if detail else ""
    if status in (401, 403):
        return AuthError(f"The provider rejected our credential{suffix}", status_code=status)
    if status == 429:
        return RateLimitError(f"Rate limited by the provider{suffix}", status_code=status)
    if 400 <= status < 500:
        return BadRequestError(f"The provider rejected the request{suffix}", status_code=status)
    return ProviderServerError(f"The provider returned {status}{suffix}", status_code=status)


def _retry_delay(attempt: int, response: httpx.Response | None) -> float:
    """Exponential backoff with jitter, but `retry-after` wins when present."""
    if response is not None:
        header = response.headers.get("retry-after")
        if header:
            try:
                return max(0.0, float(header))
            except ValueError:
                pass
    return min(8.0, 0.5 * (2**attempt)) + random.uniform(0, 0.25)


class AnthropicProvider:
    """
    The Messages API over raw HTTPS.

    No vendor SDK: the tool-use loop, the block mapping and the retry policy are
    ours, because that mapping is the interesting code and the part a framework
    would hide.
    """

    id = "anthropic"

    def __init__(self, api_key: str, base_url: str, client: httpx.AsyncClient | None = None):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
        )

    @property
    def headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

    async def send(self, request: LLMRequest) -> LLMResponse:
        body = _to_wire(request)
        url = f"{self._base_url}/v1/messages"
        last_error: LLMError | None = None

        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await self._client.post(url, json=body, headers=self.headers)
            except httpx.TimeoutException as exc:
                last_error = NetworkError(f"The provider timed out: {exc}")
            except httpx.HTTPError as exc:
                last_error = NetworkError(f"Could not reach the provider: {exc}")
            else:
                if response.status_code < 400:
                    return _from_wire(response.json())

                payload = _safe_json(response)
                error = _map_status(response.status_code, payload)
                # 4xx other than 429 are our bug, not a blip — never retried.
                if response.status_code not in RETRY_STATUSES:
                    raise error
                last_error = error
                if attempt < MAX_ATTEMPTS - 1:
                    delay = _retry_delay(attempt, response)
                    logger.warning(
                        "Provider returned %s; retrying in %.2fs (attempt %s/%s)",
                        response.status_code,
                        delay,
                        attempt + 1,
                        MAX_ATTEMPTS,
                    )
                    await asyncio.sleep(delay)
                continue

            if attempt < MAX_ATTEMPTS - 1:
                await asyncio.sleep(_retry_delay(attempt, None))

        raise last_error or NetworkError("The provider could not be reached.")

    async def aclose(self) -> None:
        await self._client.aclose()


def _safe_json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None
