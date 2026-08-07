"""
The three tool-use protocol rules, each of which produces a confusing failure
when broken:

  1. The assistant's FULL content is echoed back, tool-call blocks included.
  2. ALL tool results for a turn go in ONE user message.
  3. Every tool_call gets exactly one tool_result with the same id, failures
     included.
"""

import pytest

from app.engine.agent_loop import build_history, compose_system_prompt, run_agent_loop
from app.engine.events import EventBus
from app.errors import IterationLimitError, RefusalError
from app.llm.base import LLMResponse, TextContent, ToolCallContent, ToolResultContent, Usage
from app.tools.base import ToolContext
from tests.fakes import FakeProvider, refusal_response, text_response, tool_call_response


async def loop(provider: FakeProvider, *, tools: list[str] | None = None, max_iterations: int = 5):
    bus = EventBus("run_test")
    turn = await run_agent_loop(
        provider=provider,
        model="claude-opus-5",
        system="You are a test.",
        prompt="What is 2+2?",
        history=[],
        tool_ids=tools or [],
        max_iterations=max_iterations,
        bus=bus,
        node_id="agent",
        tool_ctx=ToolContext(),
    )
    return turn, bus


class TestProtocolRules:
    async def test_echoes_the_full_assistant_content_including_tool_calls(self) -> None:
        """
        Rule 1. Dropping the tool_use block leaves the next request with a
        tool_result that has no matching tool_use — a 400.
        """
        provider = FakeProvider(
            [
                tool_call_response("calculator", {"expression": "2+2"}, text="Let me compute."),
                text_response("It is 4."),
            ]
        )
        await loop(provider, tools=["calculator"])

        second_request = provider.requests[1]
        assistant_turn = second_request.messages[1]
        assert assistant_turn.role == "assistant"
        kinds = [block.kind for block in assistant_turn.content]
        assert "tool_call" in kinds
        assert "text" in kinds

    async def test_all_tool_results_land_in_one_user_message(self) -> None:
        """
        Rule 2. Splitting results across messages trains the model out of
        parallel tool calls.
        """
        parallel = LLMResponse(
            content=[
                ToolCallContent(id="t1", tool="calculator", input={"expression": "1+1"}),
                ToolCallContent(id="t2", tool="calculator", input={"expression": "2+2"}),
            ],
            stop_reason="tool_call",
            usage=Usage(),
        )
        provider = FakeProvider([parallel, text_response("Both done.")])
        await loop(provider, tools=["calculator"])

        result_turns = [
            message
            for message in provider.requests[1].messages
            if message.role == "user"
            and any(isinstance(block, ToolResultContent) for block in message.content)
        ]
        assert len(result_turns) == 1
        assert len(result_turns[0].content) == 2

    async def test_every_call_gets_exactly_one_result_including_failures(self) -> None:
        """Rule 3. A missing result is a 400 on the next request."""
        parallel = LLMResponse(
            content=[
                ToolCallContent(id="t1", tool="calculator", input={"expression": "1+1"}),
                ToolCallContent(id="t2", tool="calculator", input={"expression": "1/0"}),
                ToolCallContent(id="t3", tool="no_such_tool", input={}),
            ],
            stop_reason="tool_call",
            usage=Usage(),
        )
        provider = FakeProvider([parallel, text_response("Handled.")])
        await loop(provider, tools=["calculator"])

        results = [
            block
            for message in provider.requests[1].messages
            for block in message.content
            if isinstance(block, ToolResultContent)
        ]
        assert {result.call_id for result in results} == {"t1", "t2", "t3"}
        # The two failures are marked, not dropped.
        assert sum(1 for result in results if result.is_error) == 2


class TestLoopControl:
    async def test_returns_text_when_the_model_stops_calling_tools(self) -> None:
        turn, _ = await loop(FakeProvider([text_response("The answer is 4.")]))
        assert turn.text == "The answer is 4."

    async def test_runs_multiple_tool_iterations(self) -> None:
        provider = FakeProvider(
            [
                tool_call_response("calculator", {"expression": "1200*1.08"}, call_id="t1"),
                tool_call_response("calculator", {"expression": "1296/3"}, call_id="t2"),
                text_response("432."),
            ]
        )
        turn, bus = await loop(provider, tools=["calculator"])
        assert turn.text == "432."
        assert len([e for e in bus.events if e.type == "tool.call"]) == 2

    async def test_the_iteration_cap_raises_rather_than_looping_forever(self) -> None:
        provider = FakeProvider(
            [
                tool_call_response("calculator", {"expression": "1+1"}, call_id="t1"),
                tool_call_response("calculator", {"expression": "1+1"}, call_id="t2"),
            ]
        )
        with pytest.raises(IterationLimitError):
            await loop(provider, tools=["calculator"], max_iterations=2)

    async def test_a_refusal_is_checked_before_content_is_touched(self) -> None:
        """A refusal is a 200 with possibly-empty content — indexing it is a crash."""
        with pytest.raises(RefusalError) as excinfo:
            await loop(FakeProvider([refusal_response()]))
        assert "declined" in str(excinfo.value)

    async def test_max_tokens_returns_the_partial_answer_rather_than_discarding_it(self) -> None:
        truncated = LLMResponse(
            content=[TextContent(text="Half an ans")],
            stop_reason="max_tokens",
            usage=Usage(),
        )
        turn, _ = await loop(FakeProvider([truncated]))
        assert turn.text == "Half an ans"

    async def test_accumulates_usage_across_iterations(self) -> None:
        provider = FakeProvider(
            [
                tool_call_response("calculator", {"expression": "1+1"}),
                text_response("2", input_tokens=30, output_tokens=4),
            ]
        )
        turn, _ = await loop(provider, tools=["calculator"])
        assert turn.usage.input_tokens == 20 + 30
        assert turn.usage.output_tokens == 8 + 4


class TestEventsEmitted:
    async def test_emits_a_request_and_response_pair_per_iteration(self) -> None:
        provider = FakeProvider(
            [tool_call_response("calculator", {"expression": "1+1"}), text_response("2")]
        )
        _, bus = await loop(provider, tools=["calculator"])
        assert len([e for e in bus.events if e.type == "llm.request"]) == 2
        assert len([e for e in bus.events if e.type == "llm.response"]) == 2

    async def test_tool_call_and_result_share_a_call_id(self) -> None:
        provider = FakeProvider(
            [
                tool_call_response("calculator", {"expression": "6*7"}, call_id="tx"),
                text_response("42"),
            ]
        )
        _, bus = await loop(provider, tools=["calculator"])
        call = next(e for e in bus.events if e.type == "tool.call")
        result = next(e for e in bus.events if e.type == "tool.result")
        assert call.payload["call_id"] == result.payload["call_id"] == "tx"
        assert result.payload["output"] == "42"
        assert result.payload["ms"] >= 0

    async def test_text_is_emitted_as_a_final_message(self) -> None:
        _, bus = await loop(FakeProvider([text_response("Done.")]))
        message = next(e for e in bus.events if e.type == "text.message")
        assert message.payload["text"] == "Done."
        assert message.final is True
        assert message.partial is False

    async def test_events_carry_the_node_id(self) -> None:
        _, bus = await loop(FakeProvider([text_response("Done.")]))
        for event in bus.events:
            assert event.node_id == "agent"
            assert event.author == "node"


class TestToolExposure:
    async def test_only_the_enabled_tools_are_offered(self) -> None:
        provider = FakeProvider([text_response("ok")])
        await loop(provider, tools=["calculator"])
        assert [tool.name for tool in provider.requests[0].tools] == ["calculator"]

    async def test_an_agent_with_no_tools_sends_none(self) -> None:
        provider = FakeProvider([text_response("ok")])
        await loop(provider, tools=[])
        assert provider.requests[0].tools == []

    async def test_an_unknown_tool_id_is_silently_dropped_from_the_offer(self) -> None:
        provider = FakeProvider([text_response("ok")])
        await loop(provider, tools=["calculator", "ghost"])
        assert [tool.name for tool in provider.requests[0].tools] == ["calculator"]


class TestPromptComposition:
    def test_persona_is_graph_wide_and_task_is_node_local(self) -> None:
        composed = compose_system_prompt("You are precise.", "Research", "Search the web.")
        assert composed.startswith("You are precise.")
        assert "## Current step: Research" in composed
        assert "Search the web." in composed

    def test_an_empty_instruction_still_names_the_step(self) -> None:
        assert "## Current step: Reply" in compose_system_prompt("Persona.", "Reply", "")

    def test_an_empty_workflow_prompt_is_omitted_cleanly(self) -> None:
        composed = compose_system_prompt("", "Step", "Do it.")
        assert composed.startswith("## Current step: Step")

    def test_history_maps_prior_turns_and_skips_malformed_ones(self) -> None:
        messages = build_history(
            [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
                {"role": "system", "content": "ignored"},
                {"role": "user", "content": ""},
            ]
        )
        assert [message.role for message in messages] == ["user", "assistant"]
