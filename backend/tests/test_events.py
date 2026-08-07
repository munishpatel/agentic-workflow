"""
Invariants the frontend depends on. `seq` uniqueness is the load-bearing one:
nodes run concurrently under `asyncio.gather`, and a duplicated `seq` breaks
the UI's ordering.
"""

import asyncio

from app.engine.events import PREVIEW_LIMIT, EventBus, truncate_preview


class TestSequence:
    def test_seq_is_monotonic_and_starts_at_zero(self) -> None:
        bus = EventBus("run_1")
        for index in range(5):
            event = bus.emit("node.start", {"kind": "agent", "label": f"n{index}"})
            assert event.seq == index

    async def test_seq_is_unique_under_concurrent_emission(self) -> None:
        """
        The real risk: `emit` is called from nodes running under
        `asyncio.gather`. It must assign `seq` synchronously, with no `await`
        between read and increment.
        """
        bus = EventBus("run_1")

        async def emitter(count: int) -> None:
            for _ in range(count):
                bus.emit("llm.request", {"iteration": 1})
                await asyncio.sleep(0)  # force interleaving

        await asyncio.gather(*(emitter(50) for _ in range(8)))

        seqs = [event.seq for event in bus.events]
        assert len(seqs) == 400
        assert len(set(seqs)) == 400, "duplicate seq — the UI's ordering breaks"
        assert seqs == sorted(seqs)

    def test_every_event_has_a_unique_id(self) -> None:
        bus = EventBus("run_1")
        for _ in range(50):
            bus.emit("node.start", {})
        assert len({event.id for event in bus.events}) == 50


class TestEnvelope:
    def test_node_events_carry_the_node_author(self) -> None:
        bus = EventBus("run_1")
        node_event = bus.emit("node.start", {}, node_id="n1")
        run_event = bus.emit("run.start", {})
        assert (node_event.author, node_event.node_id) == ("node", "n1")
        assert (run_event.author, run_event.node_id) == ("system", None)

    def test_defaults_match_the_published_contract(self) -> None:
        event = bus_event = EventBus("run_1").emit("text.message", {"text": "hi"})
        assert event.partial is False
        assert bus_event.final is True
        assert event.branch is None  # reserved for sub-workflows

    def test_dump_is_json_ready_and_keeps_null_fields(self) -> None:
        bus = EventBus("run_1")
        bus.emit("run.start", {"workflow_id": "wf_1", "workflow_name": "Test"})
        dumped = bus.dump()[0]
        assert dumped["run_id"] == "run_1"
        assert dumped["seq"] == 0
        assert "node_id" in dumped  # present as null, not omitted
        assert isinstance(dumped["ts"], float)


class TestPreview:
    def test_short_values_pass_through(self) -> None:
        assert truncate_preview("hello") == "hello"

    def test_long_values_are_truncated_with_an_ellipsis(self) -> None:
        preview = truncate_preview("x" * 500)
        assert len(preview) == PREVIEW_LIMIT + 1
        assert preview.endswith("…")

    def test_non_strings_are_stringified(self) -> None:
        assert truncate_preview({"a": 1}) == "{'a': 1}"
        assert truncate_preview(42) == "42"
