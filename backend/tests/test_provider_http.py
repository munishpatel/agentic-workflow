"""
The HTTP layer, mocked at the wire with respx — retry policy, `retry-after`
handling, and status → typed-error mapping. Runs in CI with no API key.
"""

import httpx
import pytest
import respx

from app.llm.anthropic import ANTHROPIC_VERSION, AnthropicProvider
from app.llm.base import LLMMessage, LLMRequest, TextContent
from app.llm.errors import (
    AuthError,
    BadRequestError,
    NetworkError,
    ProviderServerError,
    RateLimitError,
)

MESSAGES_URL = "https://api.anthropic.com/v1/messages"


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    """Backoff is real; waiting for it in a test suite is not."""
    import app.llm.anthropic as module

    async def instant(_seconds: float) -> None:
        return None

    monkeypatch.setattr(module.asyncio, "sleep", instant)


@pytest.fixture
def provider() -> AnthropicProvider:
    return AnthropicProvider(api_key="sk-ant-test", base_url="https://api.anthropic.com")


def a_request() -> LLMRequest:
    return LLMRequest(
        model="claude-opus-5",
        messages=[LLMMessage(role="user", content=[TextContent(text="hi")])],
    )


def ok_payload(text: str = "Hello.") -> dict:
    return {
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 5, "output_tokens": 2},
    }


class TestHeadersAndBody:
    @respx.mock
    async def test_sends_the_three_required_headers(self, provider: AnthropicProvider) -> None:
        route = respx.post(MESSAGES_URL).mock(return_value=httpx.Response(200, json=ok_payload()))
        await provider.send(a_request())
        headers = route.calls.last.request.headers
        assert headers["x-api-key"] == "sk-ant-test"
        assert headers["anthropic-version"] == ANTHROPIC_VERSION
        assert headers["content-type"] == "application/json"

    @respx.mock
    async def test_returns_the_mapped_response(self, provider: AnthropicProvider) -> None:
        respx.post(MESSAGES_URL).mock(
            return_value=httpx.Response(200, json=ok_payload("Hi there."))
        )
        response = await provider.send(a_request())
        assert response.text == "Hi there."
        assert response.usage.input_tokens == 5


class TestRetryPolicy:
    @respx.mock
    async def test_retries_a_429_and_succeeds(self, provider: AnthropicProvider) -> None:
        route = respx.post(MESSAGES_URL).mock(
            side_effect=[
                httpx.Response(
                    429, headers={"retry-after": "0"}, json={"error": {"message": "slow down"}}
                ),
                httpx.Response(200, json=ok_payload()),
            ]
        )
        response = await provider.send(a_request())
        assert response.text == "Hello."
        assert route.call_count == 2

    @respx.mock
    async def test_honours_retry_after(self, provider: AnthropicProvider, monkeypatch) -> None:
        slept: list[float] = []
        import app.llm.anthropic as module

        async def record(seconds: float) -> None:
            slept.append(seconds)

        monkeypatch.setattr(module.asyncio, "sleep", record)
        respx.post(MESSAGES_URL).mock(
            side_effect=[
                httpx.Response(429, headers={"retry-after": "7"}, json={}),
                httpx.Response(200, json=ok_payload()),
            ]
        )
        await provider.send(a_request())
        assert slept == [7.0]

    @respx.mock
    async def test_gives_up_after_three_attempts(self, provider: AnthropicProvider) -> None:
        route = respx.post(MESSAGES_URL).mock(return_value=httpx.Response(500, json={}))
        with pytest.raises(ProviderServerError):
            await provider.send(a_request())
        assert route.call_count == 3

    @respx.mock
    async def test_retries_a_529_overloaded(self, provider: AnthropicProvider) -> None:
        route = respx.post(MESSAGES_URL).mock(
            side_effect=[httpx.Response(529, json={}), httpx.Response(200, json=ok_payload())]
        )
        await provider.send(a_request())
        assert route.call_count == 2

    @respx.mock
    async def test_never_retries_a_400(self, provider: AnthropicProvider) -> None:
        """A 400 is our bug — usually a parameter this model rejects."""
        route = respx.post(MESSAGES_URL).mock(
            return_value=httpx.Response(
                400, json={"error": {"message": "temperature: unexpected parameter"}}
            )
        )
        with pytest.raises(BadRequestError) as excinfo:
            await provider.send(a_request())
        assert route.call_count == 1
        assert "temperature" in str(excinfo.value)

    @respx.mock
    async def test_never_retries_a_401(self, provider: AnthropicProvider) -> None:
        route = respx.post(MESSAGES_URL).mock(return_value=httpx.Response(401, json={}))
        with pytest.raises(AuthError):
            await provider.send(a_request())
        assert route.call_count == 1

    @respx.mock
    async def test_retries_a_transport_failure_then_raises_network_error(
        self, provider: AnthropicProvider
    ) -> None:
        route = respx.post(MESSAGES_URL).mock(side_effect=httpx.ConnectError("refused"))
        with pytest.raises(NetworkError):
            await provider.send(a_request())
        assert route.call_count == 3

    @respx.mock
    async def test_a_timeout_becomes_a_network_error(self, provider: AnthropicProvider) -> None:
        respx.post(MESSAGES_URL).mock(side_effect=httpx.ReadTimeout("too slow"))
        with pytest.raises(NetworkError):
            await provider.send(a_request())


class TestStatusMapping:
    @respx.mock
    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (401, AuthError),
            (403, AuthError),
            (404, BadRequestError),
            (422, BadRequestError),
        ],
    )
    async def test_maps_status_to_a_typed_error(
        self, provider: AnthropicProvider, status: int, expected: type
    ) -> None:
        respx.post(MESSAGES_URL).mock(return_value=httpx.Response(status, json={}))
        with pytest.raises(expected):
            await provider.send(a_request())

    @respx.mock
    async def test_rate_limit_after_exhausting_retries(self, provider: AnthropicProvider) -> None:
        respx.post(MESSAGES_URL).mock(
            return_value=httpx.Response(429, headers={"retry-after": "0"}, json={})
        )
        with pytest.raises(RateLimitError):
            await provider.send(a_request())

    @respx.mock
    async def test_a_non_json_error_body_does_not_crash_the_mapper(
        self, provider: AnthropicProvider
    ) -> None:
        respx.post(MESSAGES_URL).mock(return_value=httpx.Response(502, text="<html>gateway</html>"))
        with pytest.raises(ProviderServerError):
            await provider.send(a_request())


class TestRefusal:
    @respx.mock
    async def test_a_refusal_returns_normally_with_the_stop_reason(
        self, provider: AnthropicProvider
    ) -> None:
        """HTTP 200 — the caller decides what to do, the transport does not raise."""
        respx.post(MESSAGES_URL).mock(
            return_value=httpx.Response(
                200,
                json={
                    "content": [],
                    "stop_reason": "refusal",
                    "stop_details": {"type": "refusal", "category": "cyber"},
                    "usage": {"input_tokens": 30, "output_tokens": 0},
                },
            )
        )
        response = await provider.send(a_request())
        assert response.stop_reason == "refusal"
        assert response.refusal_category == "cyber"
