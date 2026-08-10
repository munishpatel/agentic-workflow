"""
The human-in-the-loop gate.

One claim holds the whole feature up: **a gated tool never runs without a
verdict.** Everything else here exists to stop that claim from being true only
in the easy case — one call, one node, one approval, nothing else in flight.

The interesting cases are the ones where pausing could quietly lose or duplicate
work: an ungated sibling in the same model turn, a parallel branch mid-flight
when the pause happens, a rejection the model has to be told about, and a resume
arriving twice.
"""

import pytest

from app.engine.checkpoint import ApprovalDecision, LoopPaused, RunCheckpoint
from app.engine.events import EventBus
from app.engine.runner import execute_run, resume_run
from app.engine.scheduler import run_graph
from app.errors import IterationLimitError
from app.llm.base import LLMResponse, ToolCallContent, ToolResultContent, Usage
from app.tools.base import ToolContext
from app.tools.registry import requires_approval
from tests.conftest import edge, linear_graph, node
from tests.fakes import FakeProvider, text_response, tool_call_response

EMAIL_ARGS = {"to": "team@example.com", "subject": "Digest", "body": "Hello."}


def email_call(call_id: str = "t1", text: str = "") -> LLMResponse:
    return tool_call_response("send_email", EMAIL_ARGS, call_id=call_id, text=text)


async def run(nodes, edges, provider, **kwargs):
    bus = EventBus("run_test")
    outcome = await run_graph(
        nodes=nodes,
        edges=edges,
        workflow_name="Test",
        workflow_id="wf_test",
        system_prompt="You are a test.",
        model="claude-opus-5",
        provider=provider,
        provider_id="anthropic",
        message="email the team",
        history=[],
        bus=bus,
        tool_ctx=ToolContext(),
        **kwargs,
    )
    return outcome, bus


def events_of(bus: EventBus, event_type: str) -> list:
    return [event for event in bus.events if event.type == event_type]


def approve(*call_ids: str, note: str = "") -> dict[str, ApprovalDecision]:
    return {
        call_id: ApprovalDecision(call_id=call_id, approved=True, note=note) for call_id in call_ids
    }


def reject(*call_ids: str, note: str = "") -> dict[str, ApprovalDecision]:
    return {
        call_id: ApprovalDecision(call_id=call_id, approved=False, note=note)
        for call_id in call_ids
    }


class TestTheGateItself:
    def test_send_email_is_the_only_gated_tool(self) -> None:
        """
        If a second tool ever needs a gate, this test should be updated
        deliberately — not discovered by a reviewer wondering why nothing
        stopped for them.
        """
        assert requires_approval("send_email") is True
        assert requires_approval("calculator") is False
        assert requires_approval("web_search") is False
        assert requires_approval("current_datetime") is False

    def test_an_unknown_tool_is_not_gated(self) -> None:
        """It becomes a normal tool error in dispatch; this must not raise first."""
        assert requires_approval("no_such_tool") is False


class TestPausing:
    async def test_a_gated_call_pauses_instead_of_running(self, tmp_path) -> None:
        nodes, edges = linear_graph()
        outcome, bus = await run(nodes, edges, FakeProvider([email_call()]))

        assert outcome.status == "paused"
        assert outcome.checkpoint is not None
        held = outcome.checkpoint.pending_calls
        assert [call.tool for call in held] == ["send_email"]
        assert held[0].input == EMAIL_ARGS

        # The claim, read straight off the log: the call was announced, an
        # approval was demanded, and no result was ever produced.
        assert len(events_of(bus, "tool.call")) == 1
        assert len(events_of(bus, "approval.required")) == 1
        assert events_of(bus, "tool.result") == []
        assert events_of(bus, "run.end") == []

    async def test_the_gated_call_never_reaches_the_tool(self) -> None:
        """
        The strongest form of the claim: not "the outbox is empty afterwards"
        but "execute was never entered".
        """
        from app.tools.registry import REGISTRY

        calls: list[object] = []
        original = REGISTRY["send_email"].execute

        async def spy(args, ctx):
            calls.append(args)
            return await original(args, ctx)

        REGISTRY["send_email"].execute = spy
        try:
            nodes, edges = linear_graph()
            await run(nodes, edges, FakeProvider([email_call()]))
        finally:
            REGISTRY["send_email"].execute = original

        assert calls == []

    async def test_ungated_siblings_in_the_same_turn_still_run(self) -> None:
        """
        Holding a calculator hostage to an unrelated email protects nothing and
        costs a round trip on resume.
        """
        mixed = LLMResponse(
            content=[
                ToolCallContent(id="t1", tool="calculator", input={"expression": "2+2"}),
                ToolCallContent(id="t2", tool="send_email", input=EMAIL_ARGS),
            ],
            stop_reason="tool_call",
            usage=Usage(),
        )
        nodes, edges = linear_graph()
        outcome, bus = await run(nodes, edges, FakeProvider([mixed]))

        assert outcome.status == "paused"
        results = events_of(bus, "tool.result")
        assert [event.payload["tool"] for event in results] == ["calculator"]

        settled = outcome.checkpoint.paused[0].loop.settled
        assert [record.call_id for record in settled] == ["t1"]
        # The order the model asked in is kept, so the results message can be
        # rebuilt correctly on resume.
        assert outcome.checkpoint.paused[0].loop.order == ["t1", "t2"]

    async def test_a_gated_tool_node_pauses_too(self) -> None:
        """A literal tool node is not a way around the review."""
        nodes = [
            node("in", "input"),
            node("mail", "tool", tool_id="send_email", args=EMAIL_ARGS),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "mail", "trigger"),
            edge("e2", "mail", "result", "out", "response"),
        ]
        outcome, bus = await run(nodes, edges, FakeProvider([]))

        assert outcome.status == "paused"
        assert outcome.checkpoint.paused[0].kind == "tool"
        assert outcome.checkpoint.pending_calls[0].tool == "send_email"
        assert events_of(bus, "tool.result") == []

    async def test_a_parallel_branch_still_finishes_before_the_pause(self) -> None:
        """
        Pausing must cost the run nothing it has already earned. The sibling
        agent's answer is delivered and its node marked done, so resuming does
        not pay for it a second time.
        """
        nodes = [
            node("in", "input"),
            node("mailer", "agent", instruction="send it", tools=["send_email"]),
            node("writer", "agent", instruction="write it", tools=[]),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "mailer", "prompt"),
            edge("e2", "in", "message", "writer", "prompt"),
            edge("e3", "writer", "text", "out", "response"),
        ]

        def script(request):
            # The two agents run concurrently; answer each by its instruction.
            return email_call() if "send it" in request.system else text_response("Drafted.")

        outcome, _ = await run(nodes, edges, FakeProvider(script))

        assert outcome.status == "paused"
        assert "writer" in outcome.checkpoint.done
        assert "mailer" not in outcome.checkpoint.done
        assert ("out", "response") in {
            (node_id, port) for node_id, port, _ in outcome.checkpoint.values
        }


class TestResuming:
    async def test_approving_runs_the_call_and_finishes_the_run(self) -> None:
        nodes, edges = linear_graph()
        provider = FakeProvider([email_call(), text_response("Sent.")])
        paused, _ = await run(nodes, edges, provider)

        outcome, bus2 = await run(
            nodes,
            edges,
            provider,
            resume=paused.checkpoint,
            decisions=approve("t1"),
        )

        assert outcome.status == "ok"
        assert outcome.final_response == "Sent."
        decision = events_of(bus2, "approval.decision")[0]
        assert decision.payload["approved"] is True
        result = events_of(bus2, "tool.result")[0]
        assert result.payload["is_error"] is False
        assert "recorded" in result.payload["output"]

    async def test_rejecting_tells_the_model_and_still_finishes(self) -> None:
        nodes, edges = linear_graph()
        provider = FakeProvider([email_call(), text_response("Understood, not sent.")])
        paused, _ = await run(nodes, edges, provider)

        outcome, bus = await run(
            nodes,
            edges,
            provider,
            resume=paused.checkpoint,
            decisions=reject("t1", note="Wrong recipient."),
        )

        assert outcome.status == "ok"
        result = events_of(bus, "tool.result")[0]
        assert result.payload["is_error"] is True
        assert "rejected" in result.payload["output"]
        # The reviewer's reason reaches the model, so the agent can say more
        # than "it did not happen".
        assert "Wrong recipient." in result.payload["output"]

    async def test_a_call_with_no_decision_is_treated_as_rejected(self) -> None:
        """The safe direction for a gate whose whole job is to withhold consent."""
        nodes, edges = linear_graph()
        provider = FakeProvider([email_call(), text_response("Fine.")])
        paused, _ = await run(nodes, edges, provider)

        outcome, bus = await run(nodes, edges, provider, resume=paused.checkpoint, decisions={})

        assert outcome.status == "ok"
        assert events_of(bus, "tool.result")[0].payload["is_error"] is True

    async def test_the_model_sees_one_results_message_in_its_own_call_order(self) -> None:
        """
        Protocol rules 2 and 3, across a pause. From the model's side a run that
        waited an hour must be indistinguishable from one that did not wait.
        """
        mixed = LLMResponse(
            content=[
                ToolCallContent(id="t1", tool="calculator", input={"expression": "2+2"}),
                ToolCallContent(id="t2", tool="send_email", input=EMAIL_ARGS),
                ToolCallContent(id="t3", tool="calculator", input={"expression": "3+3"}),
            ],
            stop_reason="tool_call",
            usage=Usage(),
        )
        nodes, edges = linear_graph()
        provider = FakeProvider([mixed, text_response("All handled.")])
        paused, _ = await run(nodes, edges, provider)

        await run(nodes, edges, provider, resume=paused.checkpoint, decisions=approve("t2"))

        # The request the model saw after the approval.
        resumed_request = provider.requests[-1]
        result_turns = [
            message
            for message in resumed_request.messages
            if message.role == "user"
            and any(isinstance(block, ToolResultContent) for block in message.content)
        ]
        assert len(result_turns) == 1
        assert [block.call_id for block in result_turns[0].content] == ["t1", "t2", "t3"]

    async def test_a_resumed_node_does_not_start_a_second_time(self) -> None:
        """
        One node that paused is one step in the timeline, not two — the
        frontend groups by node id and a second start would split its own tool
        calls across two boxes.
        """
        nodes, edges = linear_graph()
        provider = FakeProvider([email_call(), text_response("Sent.")])
        paused, _ = await run(nodes, edges, provider)

        _, bus = await run(
            nodes, edges, provider, resume=paused.checkpoint, decisions=approve("t1")
        )

        starts = [event.node_id for event in events_of(bus, "node.start")]
        assert "agent" not in starts

    async def test_a_gated_tool_node_resumes_through_its_result_port(self) -> None:
        nodes = [
            node("in", "input"),
            node("mail", "tool", tool_id="send_email", args=EMAIL_ARGS),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "mail", "trigger"),
            edge("e2", "mail", "result", "out", "response"),
        ]
        paused, _ = await run(nodes, edges, FakeProvider([]))

        outcome, _ = await run(
            nodes,
            edges,
            FakeProvider([]),
            resume=paused.checkpoint,
            decisions=approve(f"node_{'mail'}"),
        )
        assert outcome.status == "ok"
        assert "recorded" in outcome.final_response

    async def test_a_rejected_tool_node_flows_on_rather_than_failing_the_run(self) -> None:
        """
        A decline is a value, not a crash — the graph decides what it means.
        """
        nodes = [
            node("in", "input"),
            node("mail", "tool", tool_id="send_email", args=EMAIL_ARGS),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "mail", "trigger"),
            edge("e2", "mail", "result", "out", "response"),
        ]
        paused, _ = await run(nodes, edges, FakeProvider([]))

        outcome, _ = await run(
            nodes,
            edges,
            FakeProvider([]),
            resume=paused.checkpoint,
            decisions=reject("node_mail"),
        )
        assert outcome.status == "ok"
        assert "rejected" in outcome.final_response

    async def test_pausing_twice_in_one_run_works(self) -> None:
        """Two gated calls in sequence: each gets its own hold."""
        nodes, edges = linear_graph()
        provider = FakeProvider(
            [
                email_call(call_id="t1"),
                email_call(call_id="t2"),
                text_response("Both handled."),
            ]
        )
        first, _ = await run(nodes, edges, provider)
        assert first.status == "paused"

        second, _ = await run(
            nodes, edges, provider, resume=first.checkpoint, decisions=approve("t1")
        )
        assert second.status == "paused"
        assert [call.call_id for call in second.checkpoint.pending_calls] == ["t2"]

        final, _ = await run(
            nodes, edges, provider, resume=second.checkpoint, decisions=approve("t2")
        )
        assert final.status == "ok"
        assert final.final_response == "Both handled."

    async def test_resuming_past_the_iteration_cap_is_reported_not_ignored(self) -> None:
        nodes = [
            node("in", "input"),
            node("agent", "agent", instruction="x", tools=["send_email"], max_tool_iterations=1),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "agent", "prompt"),
            edge("e2", "agent", "text", "out", "response"),
        ]
        provider = FakeProvider([email_call()])
        paused, _ = await run(nodes, edges, provider)

        with pytest.raises(IterationLimitError):
            await run(nodes, edges, provider, resume=paused.checkpoint, decisions=approve("t1"))


class TestAccounting:
    async def test_tokens_spent_before_the_pause_are_not_lost(self) -> None:
        """
        They were spent and they were billed. A paused run that reports zero
        under-counts the session totals the header shows.
        """
        nodes, edges = linear_graph()
        result = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=FakeProvider([email_call()]),
            provider_id="anthropic",
            message="email the team",
            history=[],
            tool_ctx=ToolContext(),
        )
        assert result.status == "paused"
        assert result.usage.input_tokens == 20
        assert result.usage.output_tokens == 8

    async def test_the_resumed_run_reports_the_whole_run_not_the_second_half(self) -> None:
        nodes, edges = linear_graph()
        provider = FakeProvider(
            [email_call(), text_response("Sent.", input_tokens=7, output_tokens=3)]
        )
        paused = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=provider,
            provider_id="anthropic",
            message="email the team",
            history=[],
            tool_ctx=ToolContext(),
        )

        final = await resume_run(
            run_id=paused.run_id,
            checkpoint=paused.checkpoint,
            decisions=approve("t1"),
            provider=provider,
            prior_events=paused.events,
            tool_ctx=ToolContext(),
        )

        assert final.status == "ok"
        assert final.usage.input_tokens == 20 + 7
        assert final.usage.output_tokens == 8 + 3


class TestOneRunOneTimeline:
    async def test_the_resumed_log_continues_rather_than_restarting(self) -> None:
        """
        A run that paused and resumed is one run with one timeline: `seq` keeps
        climbing, there is exactly one `run.start`, and the whole log replays
        through the same reducer as any other run.
        """
        nodes, edges = linear_graph()
        provider = FakeProvider([email_call(), text_response("Sent.")])
        paused = await execute_run(
            nodes=nodes,
            edges=edges,
            workflow_id="wf_test",
            workflow_name="Test",
            system_prompt="",
            model="claude-opus-5",
            provider=provider,
            provider_id="anthropic",
            message="email the team",
            history=[],
            tool_ctx=ToolContext(),
        )

        final = await resume_run(
            run_id=paused.run_id,
            checkpoint=paused.checkpoint,
            decisions=approve("t1"),
            provider=provider,
            prior_events=paused.events,
            tool_ctx=ToolContext(),
        )

        assert final.run_id == paused.run_id
        assert len(final.events) > len(paused.events)
        assert final.events[: len(paused.events)] == paused.events

        types = [event["type"] for event in final.events]
        assert types.count("run.start") == 1
        assert types.count("run.end") == 1
        assert types.count("approval.required") == 1
        assert types.count("approval.decision") == 1

        sequences = [event["seq"] for event in final.events]
        assert sequences == sorted(sequences)
        assert len(set(sequences)) == len(sequences)

    async def test_a_restored_bus_continues_the_sequence(self) -> None:
        bus = EventBus("run_x")
        bus.emit("run.start", {})
        bus.emit("node.start", {"kind": "agent", "label": "A"}, node_id="a")
        dumped = bus.dump()

        restored = EventBus.restore("run_x", dumped)
        event = restored.emit("node.end", {"kind": "agent", "label": "A", "ms": 1}, node_id="a")
        assert event.seq == 2
        assert len(restored.events) == 3


class TestCheckpointRoundTrip:
    async def test_a_checkpoint_survives_json(self) -> None:
        """
        It is stored in a JSON column and has to outlive a server restart, so
        the interesting assertion is that a round trip through JSON resumes.
        """
        nodes, edges = linear_graph()
        provider = FakeProvider([email_call(), text_response("Sent.")])
        paused, _ = await run(nodes, edges, provider)

        revived = RunCheckpoint.model_validate(paused.checkpoint.model_dump(mode="json"))
        outcome, _ = await run(nodes, edges, provider, resume=revived, decisions=approve("t1"))

        assert outcome.status == "ok"
        assert outcome.final_response == "Sent."

    async def test_the_checkpoint_carries_the_graph_not_a_reference_to_it(self) -> None:
        """
        Editing the workflow while an approval waits must not change what the
        click authorises.
        """
        nodes, edges = linear_graph()
        paused, _ = await run(nodes, edges, FakeProvider([email_call()]))

        assert [n.id for n in paused.checkpoint.nodes] == [n.id for n in nodes]
        assert [e.id for e in paused.checkpoint.edges] == [e.id for e in edges]
        assert paused.checkpoint.message == "email the team"
        assert paused.checkpoint.provider_id == "anthropic"


class TestLoopPausedIsInternal:
    async def test_the_signal_never_escapes_the_engine(self) -> None:
        """
        `LoopPaused` is control flow, not an error. It is converted to a
        `NodePaused` inside `_execute` and a paused `RunOutcome` inside
        `run_graph` — a caller must never have to catch it.
        """
        nodes, edges = linear_graph()
        try:
            outcome, _ = await run(nodes, edges, FakeProvider([email_call()]))
        except LoopPaused:  # pragma: no cover - the assertion is that we get here
            pytest.fail("LoopPaused escaped run_graph")
        assert outcome.status == "paused"
