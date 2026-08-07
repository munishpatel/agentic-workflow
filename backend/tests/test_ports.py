import pytest

from app.graph.kinds import resolve_inputs, resolve_outputs
from app.graph.ports import (
    are_mutually_exclusive,
    are_ports_compatible,
    detect_cycle_nodes,
    has_path,
)
from tests.conftest import branching_graph, edge, node, router


class TestCompatibility:
    @pytest.mark.parametrize("port_type", ["text", "json", "number", "boolean", "any"])
    def test_identical_types_connect(self, port_type: str) -> None:
        assert are_ports_compatible(port_type, port_type)

    @pytest.mark.parametrize("other", ["text", "json", "number", "boolean"])
    def test_any_is_a_wildcard_in_both_directions(self, other: str) -> None:
        assert are_ports_compatible("any", other)
        assert are_ports_compatible(other, "any")

    def test_text_and_json_are_refused(self) -> None:
        assert not are_ports_compatible("text", "json")
        assert not are_ports_compatible("json", "text")

    @pytest.mark.parametrize(
        ("source", "target"),
        [("text", "number"), ("number", "boolean"), ("boolean", "json")],
    )
    def test_other_mismatches_are_refused(self, source: str, target: str) -> None:
        assert not are_ports_compatible(source, target)


class TestDynamicPorts:
    def test_router_derives_one_text_port_per_route(self) -> None:
        ports = resolve_outputs(router("r", "needs_research", "direct"))
        assert [port.name for port in ports] == ["needs_research", "direct"]
        assert all(port.type == "text" for port in ports)

    def test_router_with_no_routes_has_no_outputs(self) -> None:
        assert resolve_outputs(router("r")) == []

    def test_malformed_routes_do_not_crash_resolution(self) -> None:
        broken = node("r", "router", routes=[{"label": "ok", "description": ""}, {"label": ""}])
        assert [port.name for port in resolve_outputs(broken)] == ["ok"]

    def test_static_kinds_return_their_declared_ports(self) -> None:
        assert [p.name for p in resolve_outputs(node("a", "agent"))] == ["text"]
        assert [p.name for p in resolve_inputs(node("a", "agent"))] == ["prompt", "context"]
        assert resolve_inputs(node("i", "input")) == []
        assert resolve_outputs(node("o", "output")) == []

    def test_tool_inputs_are_static_in_v1(self) -> None:
        # Literal args, no per-argument wired ports — so the scheduler needs no
        # dynamic input resolution for this kind.
        assert [p.name for p in resolve_inputs(node("t", "tool", tool_id="calculator"))] == [
            "trigger"
        ]


class TestReachability:
    def test_follows_edges_transitively(self) -> None:
        edges = [edge("e1", "a", "out", "b", "in"), edge("e2", "b", "out", "c", "in")]
        assert has_path(edges, "a", "c")

    def test_does_not_walk_backwards(self) -> None:
        edges = [edge("e1", "a", "out", "b", "in")]
        assert not has_path(edges, "b", "a")

    def test_terminates_on_a_cycle(self) -> None:
        edges = [
            edge("e1", "a", "out", "b", "in"),
            edge("e2", "b", "out", "c", "in"),
            edge("e3", "c", "out", "a", "in"),
        ]
        assert has_path(edges, "a", "c")
        assert detect_cycle_nodes(edges) == {"a", "b", "c"}

    def test_acyclic_graph_reports_no_cycles(self) -> None:
        _, edges = branching_graph()
        assert detect_cycle_nodes(edges) == set()


class TestMutualExclusion:
    def test_nodes_behind_different_ports_of_one_router_are_exclusive(self) -> None:
        nodes, edges = branching_graph()
        assert are_mutually_exclusive(nodes, edges, "agent_a", "agent_b")

    def test_nodes_on_the_same_branch_are_not_exclusive(self) -> None:
        nodes, edges = branching_graph()
        assert not are_mutually_exclusive(nodes, edges, "in", "agent_a")

    def test_exclusion_survives_extra_hops_past_the_router(self) -> None:
        nodes, edges = branching_graph()
        nodes.append(node("agent_a2", "agent", instruction="more a", tools=[]))
        edges.append(edge("e6", "agent_a", "text", "agent_a2", "prompt"))
        assert are_mutually_exclusive(nodes, edges, "agent_a2", "agent_b")

    def test_unrelated_nodes_are_not_exclusive(self) -> None:
        nodes = [node("a", "agent"), node("b", "agent")]
        assert not are_mutually_exclusive(nodes, [], "a", "b")
