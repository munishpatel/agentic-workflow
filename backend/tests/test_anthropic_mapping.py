"""
Pure mapping tests — no HTTP.

This is the code an SDK would hide and the part most likely to be subtly wrong,
so it is pinned on its own: our discriminated union ↔ Anthropic's `text` /
`tool_use` / `tool_result` blocks, both directions.
"""

from app.llm.anthropic import _from_wire, _to_wire
from app.llm.base import (
    LLMMessage,
    LLMRequest,
    TextContent,
    ToolCallContent,
    ToolResultContent,
    ToolSchema,
)


def request(**overrides) -> LLMRequest:
    base = {
        "model": "claude-opus-5",
        "system": "You are helpful.",
        "messages": [LLMMessage(role="user", content=[TextContent(text="hi")])],
    }
    base.update(overrides)
    return LLMRequest(**base)


class TestToWire:
    def test_maps_a_plain_text_turn(self) -> None:
        body = _to_wire(request())
        assert body["model"] == "claude-opus-5"
        assert body["system"] == "You are helpful."
        assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]

    def test_never_sends_parameters_claude_opus_5_rejects(self) -> None:
        """
        `temperature`, `top_p`, `top_k` and `budget_tokens` are all 400s on this
        model. This test is the guard against someone reintroducing one.
        """
        body = _to_wire(request())
        for banned in ("temperature", "top_p", "top_k", "budget_tokens"):
            assert banned not in body
        assert "budget_tokens" not in body.get("thinking", {})

    def test_requests_adaptive_thinking_and_a_generous_budget(self) -> None:
        body = _to_wire(request())
        assert body["thinking"] == {"type": "adaptive"}
        # Thinking shares the output budget — a tight cap truncates mid-thought.
        assert body["max_tokens"] >= 8000

    def test_effort_goes_inside_output_config_not_top_level(self) -> None:
        body = _to_wire(request(effort="high"))
        assert body["output_config"]["effort"] == "high"
        assert "effort" not in body

    def test_omits_output_config_when_there_is_nothing_to_put_in_it(self) -> None:
        body = _to_wire(request(effort=None))
        assert "output_config" not in body

    def test_structured_output_rides_in_output_config_format(self) -> None:
        schema = {"type": "json_schema", "schema": {"type": "object"}}
        body = _to_wire(request(response_format=schema, effort="low"))
        assert body["output_config"]["format"] == schema
        assert body["output_config"]["effort"] == "low"

    def test_maps_tool_definitions(self) -> None:
        tool = ToolSchema(
            name="calculator",
            description="Evaluate arithmetic.",
            input_schema={"type": "object", "properties": {"expression": {"type": "string"}}},
        )
        body = _to_wire(request(tools=[tool]))
        assert body["tools"] == [
            {
                "name": "calculator",
                "description": "Evaluate arithmetic.",
                "input_schema": tool.input_schema,
            }
        ]

    def test_omits_tools_when_there_are_none(self) -> None:
        assert "tools" not in _to_wire(request())

    def test_maps_a_tool_call_in_an_assistant_turn(self) -> None:
        body = _to_wire(
            request(
                messages=[
                    LLMMessage(
                        role="assistant",
                        content=[
                            TextContent(text="Let me compute that."),
                            ToolCallContent(
                                id="toolu_1", tool="calculator", input={"expression": "2+2"}
                            ),
                        ],
                    )
                ]
            )
        )
        blocks = body["messages"][0]["content"]
        assert blocks[0] == {"type": "text", "text": "Let me compute that."}
        assert blocks[1] == {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "calculator",
            "input": {"expression": "2+2"},
        }

    def test_maps_tool_results_including_the_error_flag(self) -> None:
        body = _to_wire(
            request(
                messages=[
                    LLMMessage(
                        role="user",
                        content=[
                            ToolResultContent(call_id="toolu_1", output="4"),
                            ToolResultContent(call_id="toolu_2", output="boom", is_error=True),
                        ],
                    )
                ]
            )
        )
        blocks = body["messages"][0]["content"]
        assert blocks[0] == {
            "type": "tool_result",
            "tool_use_id": "toolu_1",
            "content": "4",
            "is_error": False,
        }
        assert blocks[1]["is_error"] is True

    def test_omits_an_empty_system_prompt(self) -> None:
        assert "system" not in _to_wire(request(system=""))


class TestFromWire:
    def test_maps_text_and_usage(self) -> None:
        response = _from_wire(
            {
                "content": [{"type": "text", "text": "Hello."}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 12, "output_tokens": 3},
            }
        )
        assert response.text == "Hello."
        assert response.stop_reason == "end"
        assert response.usage.input_tokens == 12
        assert response.usage.output_tokens == 3

    def test_maps_tool_use_to_a_tool_call(self) -> None:
        response = _from_wire(
            {
                "content": [
                    {"type": "text", "text": "Calculating."},
                    {
                        "type": "tool_use",
                        "id": "toolu_9",
                        "name": "calculator",
                        "input": {"expression": "1+1"},
                    },
                ],
                "stop_reason": "tool_use",
            }
        )
        assert response.stop_reason == "tool_call"
        assert len(response.tool_calls) == 1
        call = response.tool_calls[0]
        assert (call.id, call.tool, call.input) == ("toolu_9", "calculator", {"expression": "1+1"})

    def test_a_refusal_is_a_stop_reason_not_an_exception(self) -> None:
        """
        A refusal is an HTTP 200 with a possibly-empty `content`. Indexing
        `content[0]` blindly here is the crash this guards against.
        """
        response = _from_wire(
            {
                "content": [],
                "stop_reason": "refusal",
                "stop_details": {"type": "refusal", "category": "cyber"},
                "usage": {"input_tokens": 40, "output_tokens": 0},
            }
        )
        assert response.stop_reason == "refusal"
        assert response.refusal_category == "cyber"
        assert response.text == ""
        assert response.tool_calls == []

    def test_max_tokens_is_distinguished_from_a_normal_end(self) -> None:
        assert _from_wire({"stop_reason": "max_tokens"}).stop_reason == "max_tokens"

    def test_stop_sequence_counts_as_a_normal_end(self) -> None:
        assert _from_wire({"stop_reason": "stop_sequence"}).stop_reason == "end"

    def test_unknown_stop_reason_degrades_to_end(self) -> None:
        assert _from_wire({"stop_reason": "something_new"}).stop_reason == "end"

    def test_thinking_and_unknown_blocks_are_skipped_not_fatal(self) -> None:
        response = _from_wire(
            {
                "content": [
                    {"type": "thinking", "thinking": "", "signature": "abc"},
                    {"type": "some_future_block", "data": 1},
                    {"type": "text", "text": "Answer."},
                ],
                "stop_reason": "end_turn",
            }
        )
        assert response.text == "Answer."

    def test_an_empty_payload_does_not_raise(self) -> None:
        response = _from_wire({})
        assert response.stop_reason == "end"
        assert response.text == ""


class TestRoundTrip:
    def test_a_full_tool_exchange_survives_both_directions(self) -> None:
        """
        The shape the agent loop actually builds: assistant turn with text +
        tool_use, then a user turn carrying the result.
        """
        original = request(
            messages=[
                LLMMessage(role="user", content=[TextContent(text="What is 2+2?")]),
                LLMMessage(
                    role="assistant",
                    content=[
                        TextContent(text="Let me calculate."),
                        ToolCallContent(
                            id="toolu_1", tool="calculator", input={"expression": "2+2"}
                        ),
                    ],
                ),
                LLMMessage(role="user", content=[ToolResultContent(call_id="toolu_1", output="4")]),
            ]
        )
        body = _to_wire(original)
        assert [message["role"] for message in body["messages"]] == [
            "user",
            "assistant",
            "user",
        ]
        # Every tool_use has exactly one matching tool_result — the invariant a
        # missing pair would turn into a 400 on the next request.
        call_ids = {
            block["id"]
            for message in body["messages"]
            for block in message["content"]
            if block["type"] == "tool_use"
        }
        result_ids = {
            block["tool_use_id"]
            for message in body["messages"]
            for block in message["content"]
            if block["type"] == "tool_result"
        }
        assert call_ids == result_ids

    def test_a_response_can_be_fed_straight_back_as_an_assistant_turn(self) -> None:
        response = _from_wire(
            {
                "content": [
                    {"type": "text", "text": "Working."},
                    {"type": "tool_use", "id": "toolu_1", "name": "calc", "input": {"x": 1}},
                ],
                "stop_reason": "tool_use",
            }
        )
        body = _to_wire(request(messages=[LLMMessage(role="assistant", content=response.content)]))
        blocks = body["messages"][0]["content"]
        assert [block["type"] for block in blocks] == ["text", "tool_use"]
        assert blocks[1]["id"] == "toolu_1"
