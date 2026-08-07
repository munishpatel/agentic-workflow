"""
The scheduler is the subtlest code in the service, and pruning is the subtlest
part of it. The headline test is that choosing one router branch must NOT prune
an output node that the *other*, live branch still feeds.
"""

import pytest

from app.engine.events import EventBus
from app.engine.runner import execute_run
from app.engine.scheduler import run_graph
from app.errors import NodeLimitError, StarvedOutputError
from app.tools.base import ToolContext
from tests.conftest import branching_graph, edge, linear_graph, node, router
from tests.fakes import (
    FakeProvider,
    refusal_response,
    route_response,
    text_response,
    tool_call_response,
)


async def run(nodes, edges, provider, message: str = "hello", **kwargs):
    bus = EventBus("run_test")
    outcome = await run_graph(
        nodes=nodes,
        edges=edges,
        workflow_name="Test",
        workflow_id="wf_test",
        system_prompt="You are a test.",
        model="claude-opus-5",
        provider=provider,
        message=message,
        history=[],
        bus=bus,
        tool_ctx=ToolContext(),
        **kwargs,
    )
    return outcome, bus


def events_of(bus: EventBus, event_type: str) -> list:
    return [event for event in bus.events if event.type == event_type]


class TestLinearRun:
    async def test_runs_input_agent_output_in_order(self) -> None:
        nodes, edges = linear_graph()
        outcome, bus = await run(nodes, edges, FakeProvider([text_response("The answer.")]))
        assert outcome.final_response == "The answer."
        assert [event.node_id for event in events_of(bus, "node.start")] == ["in", "agent", "out"]

    async def test_emits_one_edge_transfer_per_traversed_edge(self) -> None:
        nodes, edges = linear_graph()
        _, bus = await run(nodes, edges, FakeProvider([text_response("ok")]))
        transfers = events_of(bus, "edge.transfer")
        assert len(transfers) == 2
        assert transfers[0].payload["source"] == {"node_id": "in", "port": "message"}
        assert transfers[0].payload["port_type"] == "text"
        assert transfers[0].payload["preview"] == "hello"

    async def test_accumulates_usage_across_the_run(self) -> None:
        nodes, edges = linear_graph()
        outcome, _ = await run(
            nodes, edges, FakeProvider([text_response("ok", input_tokens=100, output_tokens=20)])
        )
        assert outcome.usage.input_tokens == 100
        assert outcome.usage.output_tokens == 20

    async def test_the_user_message_reaches_the_agent(self) -> None:
        nodes, edges = linear_graph()
        provider = FakeProvider([text_response("ok")])
        await run(nodes, edges, provider, message="What is 2+2?")
        last_user_turn = provider.requests[0].messages[-1]
        assert last_user_turn.content[0].text == "What is 2+2?"

    async def test_the_node_instruction_composes_onto_the_workflow_persona(self) -> None:
        nodes, edges = linear_graph()
        provider = FakeProvider([text_response("ok")])
        await run(nodes, edges, provider)
        system = provider.requests[0].system
        assert "You are a test." in system
        assert "## Current step: agent" in system
        assert "answer" in system


class TestRouterPruning:
    async def test_choosing_a_branch_prunes_only_the_other_branch(self) -> None:
        """
        The headline case. `input → router → {A | B} → output`: choosing A must
        prune B and must NOT prune `output`, which A still feeds.
        """
        nodes, edges = branching_graph()
        provider = FakeProvider([route_response("a"), text_response("A ran.")])
        outcome, bus = await run(nodes, edges, provider)

        skipped = {event.node_id for event in events_of(bus, "node.skipped")}
        assert skipped == {"agent_b"}
        started = {event.node_id for event in events_of(bus, "node.start")}
        assert "out" in started
        assert "agent_b" not in started
        assert outcome.final_response == "A ran."

    async def test_choosing_the_other_branch_is_symmetric(self) -> None:
        nodes, edges = branching_graph()
        provider = FakeProvider([route_response("b"), text_response("B ran.")])
        outcome, bus = await run(nodes, edges, provider)
        assert {event.node_id for event in events_of(bus, "node.skipped")} == {"agent_a"}
        assert outcome.final_response == "B ran."

    async def test_node_skipped_carries_a_reason(self) -> None:
        nodes, edges = branching_graph()
        _, bus = await run(nodes, edges, FakeProvider([route_response("a"), text_response("A.")]))
        skipped = events_of(bus, "node.skipped")[0]
        assert skipped.payload["reason"]
        assert skipped.payload["kind"] == "agent"
        assert skipped.payload["label"] == "agent_b"

    async def test_pruning_is_transitive_down_a_dead_branch(self) -> None:
        """A node two hops past a dead branch is pruned too."""
        nodes, edges = branching_graph()
        nodes.append(node("agent_b2", "agent", instruction="more b", tools=[]))
        edges.append(edge("e6", "agent_b", "text", "agent_b2", "prompt"))
        _, bus = await run(nodes, edges, FakeProvider([route_response("a"), text_response("A.")]))
        assert {event.node_id for event in events_of(bus, "node.skipped")} == {
            "agent_b",
            "agent_b2",
        }

    async def test_the_router_emits_its_decision_with_the_options_considered(self) -> None:
        nodes, edges = branching_graph()
        _, bus = await run(
            nodes, edges, FakeProvider([route_response("a", "picked a"), text_response("A.")])
        )
        decision = events_of(bus, "route.decision")[0]
        assert decision.payload["chosen"] == "a"
        assert decision.payload["reason"] == "picked a"
        assert decision.payload["considered"] == ["a", "b"]

    async def test_an_unknown_route_label_falls_back_rather_than_crashing(self) -> None:
        nodes, edges = branching_graph()
        provider = FakeProvider([route_response("nonexistent"), text_response("A.")])
        outcome, bus = await run(nodes, edges, provider)
        assert events_of(bus, "route.decision")[0].payload["chosen"] == "a"
        assert outcome.final_response == "A."

    async def test_unparseable_router_output_falls_back(self) -> None:
        nodes, edges = branching_graph()
        provider = FakeProvider([text_response("I think route a, probably"), text_response("A.")])
        outcome, _ = await run(nodes, edges, provider)
        assert outcome.final_response == "A."


class TestToolNodes:
    async def test_a_tool_node_runs_deterministically_with_no_model(self) -> None:
        nodes = [
            node("in", "input"),
            node("t", "tool", tool_id="calculator", args={"expression": "6 * 7"}),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "t", "trigger"),
            edge("e2", "t", "result", "out", "response"),
        ]
        provider = FakeProvider([])
        outcome, bus = await run(nodes, edges, provider)
        assert outcome.final_response == "42"
        assert provider.requests == []  # no model in the path
        assert events_of(bus, "tool.result")[0].payload["output"] == "42"

    async def test_a_failing_tool_node_still_produces_a_result(self) -> None:
        nodes = [
            node("in", "input"),
            node("t", "tool", tool_id="calculator", args={"expression": "1/0"}),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "t", "trigger"),
            edge("e2", "t", "result", "out", "response"),
        ]
        _, bus = await run(nodes, edges, FakeProvider([]))
        assert events_of(bus, "tool.result")[0].payload["is_error"] is True


class TestGuards:
    async def test_a_starved_output_emits_run_error_rather_than_hanging(self) -> None:
        """
        A graph that validates but starves at run time: only branch A feeds the
        output, so choosing B prunes the only path to it. Never hang, never
        return an empty success — say which node stalled.
        """
        nodes = [
            node("in", "input"),
            router("route", "a", "b"),
            node("agent_a", "agent", instruction="a", tools=[]),
            node("agent_b", "agent", instruction="b", tools=[]),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "route", "input"),
            edge("e2", "route", "a", "agent_a", "prompt"),
            edge("e3", "route", "b", "agent_b", "prompt"),
            edge("e4", "agent_a", "text", "out", "response"),
        ]
        from app.graph.validate import validate_graph

        assert validate_graph(nodes, edges).valid, "the graph itself must be legal"

        with pytest.raises(StarvedOutputError):
            await run(nodes, edges, FakeProvider([route_response("b"), text_response("B.")]))

    async def test_the_node_execution_cap_is_enforced(self, monkeypatch) -> None:
        import app.engine.scheduler as module

        monkeypatch.setattr(module, "MAX_NODE_EXECUTIONS", 2)
        nodes, edges = linear_graph()
        with pytest.raises(NodeLimitError):
            await run(nodes, edges, FakeProvider([text_response("ok")]))


class TestRunnerErrorShape:
    async def test_a_refusal_returns_200_with_a_timeline_ending_in_run_error(self) -> None:
        """
        The partial timeline is what the user needs; a 500 would discard it.
        """
        nodes, edges = linear_graph()
        result = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=FakeProvider([refusal_response()]),
            message="hello",
            history=[],
            tool_ctx=ToolContext(),
        )
        assert result.status == "error"
        assert result.final_response == ""
        assert result.events[-1]["type"] == "run.error"
        assert result.events[-1]["payload"]["code"] == "refusal"
        # The nodes that did run are still in the log.
        assert any(event["type"] == "node.start" for event in result.events)

    async def test_a_successful_run_ends_in_run_end_that_agrees_with_the_response(self) -> None:
        nodes, edges = linear_graph()
        result = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=FakeProvider([text_response("Done.")]),
            message="hello",
            history=[],
            tool_ctx=ToolContext(),
        )
        assert result.status == "ok"
        run_end = result.events[-1]
        assert run_end["type"] == "run.end"
        # The UI takes the message from one and the timeline from the other —
        # they must agree.
        assert run_end["payload"]["final_response"] == result.final_response
        assert run_end["payload"]["duration_ms"] == result.duration_ms
        assert run_end["payload"]["usage"]["input_tokens"] == result.usage.input_tokens

    async def test_a_failed_run_still_reports_the_tokens_it_spent(self) -> None:
        """
        Found by a live run: a run that dies mid-way had spent ~25k input tokens
        and reported zero. They were billed, so the session totals must show
        them — and the reported figure must match the timeline.
        """
        nodes = [
            node("in", "input"),
            node("a", "agent", instruction="loop", tools=["calculator"], max_tool_iterations=2),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "a", "prompt"),
            edge("e2", "a", "text", "out", "response"),
        ]
        result = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=FakeProvider(
                [
                    tool_call_response("calculator", {"expression": "1+1"}, call_id="t1"),
                    tool_call_response("calculator", {"expression": "2+2"}, call_id="t2"),
                ]
            ),
            message="go",
            history=[],
            tool_ctx=ToolContext(),
        )
        assert result.status == "error"
        assert result.usage.input_tokens > 0, "tokens were spent and billed"
        # Whatever is reported must equal what the timeline shows.
        from_events = sum(
            event["payload"]["usage"]["input_tokens"]
            for event in result.events
            if event["type"] == "llm.response"
        )
        assert result.usage.input_tokens == from_events

    async def test_reported_usage_matches_the_timeline_on_a_successful_run(self) -> None:
        """The success and failure paths compute usage differently; they must agree."""
        nodes, edges = linear_graph()
        result = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=FakeProvider([text_response("Done.", input_tokens=77, output_tokens=9)]),
            message="hello",
            history=[],
            tool_ctx=ToolContext(),
        )
        from_events = sum(
            event["payload"]["usage"]["input_tokens"]
            for event in result.events
            if event["type"] == "llm.response"
        )
        assert result.usage.input_tokens == from_events == 77

    async def test_an_iteration_limit_becomes_run_error_not_a_crash(self) -> None:
        nodes = [
            node("in", "input"),
            node("a", "agent", instruction="loop", tools=["calculator"], max_tool_iterations=2),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "a", "prompt"),
            edge("e2", "a", "text", "out", "response"),
        ]
        provider = FakeProvider(
            [
                tool_call_response("calculator", {"expression": "1+1"}, call_id="t1"),
                tool_call_response("calculator", {"expression": "2+2"}, call_id="t2"),
            ]
        )
        result = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=provider,
            message="go",
            history=[],
            tool_ctx=ToolContext(),
        )
        assert result.status == "error"
        assert result.events[-1]["payload"]["code"] == "iteration_limit"
