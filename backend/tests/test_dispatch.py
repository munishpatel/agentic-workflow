"""
Dispatch's contract is one sentence: **it never raises**. Every failure mode
becomes a `ToolResult` with `is_error=True`, so a broken tool can never abort
the agent loop — the model gets the error and a chance to recover.
"""

import asyncio
import json
from types import SimpleNamespace
from typing import ClassVar

import httpx
import pytest
import respx
from pydantic import BaseModel

from app.tools import registry
from app.tools.base import ToolContext, ToolResult
from app.tools.dispatch import dispatch


def _settings(**overrides: object) -> SimpleNamespace:
    """A stand-in for `Settings` — the tools only read attributes off it."""
    defaults: dict[str, object] = {
        "search_api_key": "",
        "anthropic_api_key": "",
        "anthropic_base_url": "https://api.anthropic.com",
        "llm_model": "claude-sonnet-5",
    }
    return SimpleNamespace(**{**defaults, **overrides})


class EchoInput(BaseModel):
    text: str


@pytest.fixture
def rogue_tools():
    """Register misbehaving tools for the duration of one test, then clean up."""

    class Raising:
        id: ClassVar[str] = "_raises"
        name: ClassVar[str] = "Raises"
        description: ClassVar[str] = "Always raises."
        Input: ClassVar[type[BaseModel]] = EchoInput

        async def execute(self, args: EchoInput, ctx: ToolContext) -> ToolResult:
            raise RuntimeError("kaboom")

    class Hanging:
        id: ClassVar[str] = "_hangs"
        name: ClassVar[str] = "Hangs"
        description: ClassVar[str] = "Never returns."
        Input: ClassVar[type[BaseModel]] = EchoInput

        async def execute(self, args: EchoInput, ctx: ToolContext) -> ToolResult:
            await asyncio.sleep(3600)
            return ToolResult(output="never")

    class WrongType:
        id: ClassVar[str] = "_wrong"
        name: ClassVar[str] = "Wrong"
        description: ClassVar[str] = "Returns the wrong type."
        Input: ClassVar[type[BaseModel]] = EchoInput

        async def execute(self, args: EchoInput, ctx: ToolContext):
            return {"not": "a ToolResult"}

    for cls in (Raising, Hanging, WrongType):
        registry.REGISTRY[cls.id] = cls()
    yield
    for cls in (Raising, Hanging, WrongType):
        registry.REGISTRY.pop(cls.id, None)


class TestNeverRaises:
    async def test_unknown_tool_id(self) -> None:
        outcome = await dispatch("no_such_tool", {}, ToolContext())
        assert outcome.result.is_error is True
        assert "no tool called" in outcome.result.output

    async def test_invalid_arguments_carry_pydantics_message(self) -> None:
        """The model needs to know *which* field was wrong to retry correctly."""
        outcome = await dispatch("calculator", {"wrong_field": 1}, ToolContext())
        assert outcome.result.is_error is True
        assert "expression" in outcome.result.output

    async def test_a_raising_tool_becomes_an_error_result(self, rogue_tools) -> None:
        outcome = await dispatch("_raises", {"text": "x"}, ToolContext())
        assert outcome.result.is_error is True
        assert "kaboom" in outcome.result.output

    async def test_a_hanging_tool_times_out(self, rogue_tools, monkeypatch) -> None:
        import app.tools.dispatch as module

        monkeypatch.setattr(module, "TOOL_TIMEOUT_SECONDS", 0.05)
        outcome = await dispatch("_hangs", {"text": "x"}, ToolContext())
        assert outcome.result.is_error is True
        assert "timed out" in outcome.result.output

    async def test_a_tool_returning_the_wrong_type_is_caught(self, rogue_tools) -> None:
        outcome = await dispatch("_wrong", {"text": "x"}, ToolContext())
        assert outcome.result.is_error is True

    async def test_cancellation_still_propagates(self, rogue_tools, monkeypatch) -> None:
        """A cancelled run is not a tool failure — it must not be swallowed."""

        class Cancelling:
            id = "_cancels"
            name = "Cancels"
            description = "Raises CancelledError."
            Input = EchoInput

            async def execute(self, args, ctx):
                raise asyncio.CancelledError

        registry.REGISTRY["_cancels"] = Cancelling()
        try:
            with pytest.raises(asyncio.CancelledError):
                await dispatch("_cancels", {"text": "x"}, ToolContext())
        finally:
            registry.REGISTRY.pop("_cancels", None)


class TestSuccessPath:
    async def test_a_working_tool_returns_its_output_and_a_duration(self) -> None:
        outcome = await dispatch("calculator", {"expression": "6 * 7"}, ToolContext())
        assert outcome.result.is_error is False
        assert outcome.result.output == "42"
        assert outcome.ms >= 0

    async def test_a_tool_that_reports_its_own_failure_is_passed_through(self) -> None:
        outcome = await dispatch("calculator", {"expression": "1/0"}, ToolContext())
        assert outcome.result.is_error is True
        assert "Division by zero" in outcome.result.output


class TestRegistryContract:
    def test_the_four_v1_tools_are_registered(self) -> None:
        assert set(registry.tool_ids()) >= {
            "calculator",
            "web_search",
            "send_email",
            "current_datetime",
        }

    def test_metadata_carries_a_usable_json_schema(self) -> None:
        by_id = {meta["id"]: meta for meta in registry.tool_metadata()}
        schema = by_id["web_search"]["input_schema"]
        assert schema["type"] == "object"
        assert "query" in schema["properties"]

    def test_descriptions_say_when_to_call_not_just_what_it_does(self) -> None:
        """An under-described tool is the usual cause of an agent that never calls it."""
        for meta in registry.tool_metadata():
            assert "Call this" in meta["description"] or "Do not call" in meta["description"]
            assert len(meta["description"]) > 80

    def test_tool_schemas_ignores_ids_that_do_not_exist(self) -> None:
        schemas = registry.tool_schemas(["calculator", "ghost_tool"])
        assert [schema["name"] for schema in schemas] == ["calculator"]


class TestWebSearchFallback:
    """
    Three tiers, in order: Tavily → Anthropic's server-side search → labelled
    placeholders. Each tier exists so the app still runs with one fewer key.
    """

    async def test_falls_back_to_mock_when_no_key_is_set_at_all(self) -> None:
        """A reviewer with no keys must never see fabricated results unlabelled."""
        outcome = await dispatch("web_search", {"query": "anything"}, ToolContext())
        assert outcome.result.is_error is False
        assert "MOCK RESULTS" in outcome.result.output

    @respx.mock
    async def test_uses_anthropic_server_search_when_only_the_llm_key_is_set(self) -> None:
        route = respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(
                200,
                json={
                    "stop_reason": "end_turn",
                    "content": [
                        {"type": "server_tool_use", "id": "s1", "name": "web_search"},
                        {"type": "web_search_tool_result", "tool_use_id": "s1", "content": []},
                        {"type": "text", "text": "1. Result\n   https://example.org\n   Snippet."},
                    ],
                },
            )
        )
        ctx = ToolContext(settings=_settings(anthropic_api_key="sk-ant-test"))

        outcome = await dispatch("web_search", {"query": "python 3.14"}, ctx)

        assert outcome.result.is_error is False
        assert "MOCK RESULTS" not in outcome.result.output
        assert "https://example.org" in outcome.result.output

        body = json.loads(route.calls[0].request.content)
        assert body["tools"] == [{"type": "web_search_20260209", "name": "web_search"}]
        # The banned sampling parameters must not creep in on this path either.
        assert not {"temperature", "top_p", "top_k"} & body.keys()

    @respx.mock
    async def test_search_is_pinned_to_sonnet_whatever_the_workflow_runs_on(self) -> None:
        """
        The search call is a lookup, not the agent thinking, so it must not
        follow LLM_MODEL. `claude-haiku-4-5` would 400 on the tool version this
        sends, and the per-search cost should not change with the workflow.
        """
        route = respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(
                200, json={"stop_reason": "end_turn", "content": [{"type": "text", "text": "ok"}]}
            )
        )
        ctx = ToolContext(
            settings=_settings(anthropic_api_key="sk-ant-test", llm_model="claude-haiku-4-5")
        )

        await dispatch("web_search", {"query": "anything"}, ctx)

        body = json.loads(route.calls[0].request.content)
        assert body["model"] == "claude-sonnet-5"
        assert body["tools"][0]["type"] == "web_search_20260209"

    @respx.mock
    async def test_a_provider_failure_becomes_an_error_result_not_a_raise(self) -> None:
        respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(500, json={})
        )
        ctx = ToolContext(settings=_settings(anthropic_api_key="sk-ant-test"))

        outcome = await dispatch("web_search", {"query": "anything"}, ctx)

        assert outcome.result.is_error is True

    @respx.mock
    async def test_a_refusal_is_an_error_rather_than_an_empty_result(self) -> None:
        respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json={"stop_reason": "refusal", "content": []})
        )
        ctx = ToolContext(settings=_settings(anthropic_api_key="sk-ant-test"))

        outcome = await dispatch("web_search", {"query": "anything"}, ctx)

        assert outcome.result.is_error is True

    @respx.mock
    async def test_tavily_wins_when_both_keys_are_set(self) -> None:
        anthropic = respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json={"content": []})
        )
        tavily = respx.post("https://api.tavily.com/search").mock(
            return_value=httpx.Response(
                200,
                json={"results": [{"title": "T", "url": "https://t.example", "content": "c"}]},
            )
        )
        ctx = ToolContext(settings=_settings(search_api_key="tvly-x", anthropic_api_key="sk-ant"))

        outcome = await dispatch("web_search", {"query": "anything"}, ctx)

        assert tavily.called
        assert not anthropic.called
        assert "https://t.example" in outcome.result.output


class TestMockedTools:
    async def test_send_email_validates_the_address(self) -> None:
        outcome = await dispatch(
            "send_email", {"to": "not-an-email", "subject": "s", "body": "b"}, ToolContext()
        )
        assert outcome.result.is_error is True

    async def test_send_email_accepts_a_valid_address_without_a_session(self) -> None:
        outcome = await dispatch(
            "send_email", {"to": "a@example.com", "subject": "s", "body": "b"}, ToolContext()
        )
        assert outcome.result.is_error is False
        assert "nothing was actually sent" in outcome.result.output

    async def test_current_datetime_rejects_an_unknown_timezone(self) -> None:
        outcome = await dispatch("current_datetime", {"timezone": "Mars/Olympus"}, ToolContext())
        assert outcome.result.is_error is True

    async def test_current_datetime_returns_a_formatted_time(self) -> None:
        outcome = await dispatch("current_datetime", {"timezone": "UTC"}, ToolContext())
        assert outcome.result.is_error is False
        assert "UTC" in outcome.result.output
