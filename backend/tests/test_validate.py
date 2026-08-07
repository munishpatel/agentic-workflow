from app.graph.types import Edge, Node
from app.graph.validate import validate_graph
from tests.conftest import branching_graph, edge, linear_graph, node, router


def codes(issues: list) -> list[str]:
    return [issue.code for issue in issues]


class TestValidGraphs:
    def test_the_seeded_branching_graph_validates_clean(self) -> None:
        """
        The headline case. Two edges converge on `output.response`, which is
        only legal because the sources sit behind different router ports — if
        this ever fails, branching workflows are unbuildable.
        """
        result = validate_graph(*branching_graph())
        assert result.valid, result.errors
        assert result.errors == []

    def test_the_minimal_linear_graph_validates_clean(self) -> None:
        result = validate_graph(*linear_graph())
        assert result.valid, result.errors


class TestStructuralErrors:
    def test_missing_output_node(self) -> None:
        nodes, edges = linear_graph()
        nodes = [n for n in nodes if n.kind != "output"]
        edges = [e for e in edges if e.target.node_id != "out"]
        assert "missing_output_node" in codes(validate_graph(nodes, edges).errors)

    def test_missing_input_node(self) -> None:
        nodes, edges = linear_graph()
        nodes = [n for n in nodes if n.kind != "input"]
        edges = [e for e in edges if e.source.node_id != "in"]
        assert "missing_input_node" in codes(validate_graph(nodes, edges).errors)

    def test_duplicate_input_node(self) -> None:
        nodes, edges = linear_graph()
        nodes.append(node("in2", "input"))
        assert "duplicate_input_node" in codes(validate_graph(nodes, edges).errors)

    def test_duplicate_output_node(self) -> None:
        nodes, edges = linear_graph()
        nodes.append(node("out2", "output"))
        assert "duplicate_output_node" in codes(validate_graph(nodes, edges).errors)

    def test_unknown_node_kind(self) -> None:
        nodes, edges = linear_graph()
        # Bypass the Literal on purpose — a stored graph could carry a kind this
        # build no longer publishes.
        rogue = Node.model_construct(id="x", kind="subworkflow", label="x", config={})
        nodes.append(rogue)
        assert "unknown_node_kind" in codes(validate_graph(nodes, edges).errors)


class TestEdgeErrors:
    def test_dangling_edge(self) -> None:
        nodes, edges = linear_graph()
        edges.append(edge("e_bad", "ghost", "text", "out", "response"))
        assert "dangling_edge" in codes(validate_graph(nodes, edges).errors)

    def test_unknown_port(self) -> None:
        nodes, edges = linear_graph()
        edges.append(edge("e_bad", "agent", "nope", "out", "response"))
        assert "unknown_port" in codes(validate_graph(nodes, edges).errors)

    def test_port_type_mismatch_text_to_json(self) -> None:
        nodes = [
            node("in", "input"),
            node(
                "r",
                "router",
                routes=[{"label": "a", "description": ""}, {"label": "b", "description": ""}],
            ),
        ]
        # input.history is json; router.input is text
        edges = [edge("e1", "in", "history", "r", "input")]
        assert "port_type_mismatch" in codes(validate_graph(nodes, edges).errors)

    def test_two_live_sources_on_one_input_is_refused(self) -> None:
        nodes, edges = linear_graph()
        nodes.append(node("agent2", "agent", instruction="also", tools=[]))
        edges.append(edge("e3", "in", "message", "agent2", "prompt"))
        edges.append(edge("e4", "agent2", "text", "out", "response"))
        result = validate_graph(nodes, edges)
        assert "port_already_connected" in codes(result.errors)

    def test_cycle_detected(self) -> None:
        nodes = [
            node("in", "input"),
            node("a", "agent", instruction="a", tools=[]),
            node("b", "agent", instruction="b", tools=[]),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "a", "prompt"),
            edge("e2", "a", "text", "b", "prompt"),
            edge("e3", "b", "text", "a", "context"),
            edge("e4", "b", "text", "out", "response"),
        ]
        assert "cycle_detected" in codes(validate_graph(nodes, edges).errors)


class TestNodeErrors:
    def test_starved_input(self) -> None:
        nodes = [node("in", "input"), node("out", "output")]
        result = validate_graph(nodes, [])
        starved = [i for i in result.errors if i.code == "starved_input"]
        assert starved and starved[0].node_id == "out"

    def test_router_needs_at_least_two_routes(self) -> None:
        nodes = [node("in", "input"), router("r", "only"), node("out", "output")]
        edges = [
            edge("e1", "in", "message", "r", "input"),
            edge("e2", "r", "only", "out", "response"),
        ]
        assert "router_needs_routes" in codes(validate_graph(nodes, edges).errors)

    def test_tool_node_without_a_tool_selected(self) -> None:
        nodes = [node("in", "input"), node("t", "tool", tool_id=""), node("out", "output")]
        edges = [
            edge("e1", "in", "message", "t", "trigger"),
            edge("e2", "t", "result", "out", "response"),
        ]
        assert "tool_not_selected" in codes(validate_graph(nodes, edges).errors)


class TestWarnings:
    def test_empty_instruction_is_a_warning_not_an_error(self) -> None:
        nodes, edges = linear_graph()
        nodes = [
            node("in", "input"),
            node("agent", "agent", instruction="", tools=[]),
            node("out", "output"),
        ]
        result = validate_graph(nodes, edges)
        assert "empty_instruction" in codes(result.warnings)
        assert result.valid

    def test_dangling_output_is_a_warning(self) -> None:
        nodes = [
            node("in", "input"),
            node("a", "agent", instruction="x", tools=[]),
            node("out", "output"),
        ]
        edges = [
            edge("e1", "in", "message", "a", "prompt"),
            edge("e2", "in", "message", "out", "response"),
        ]
        result = validate_graph(nodes, edges)
        assert "dangling_output" in codes(result.warnings)

    def test_unreachable_node_is_a_warning(self) -> None:
        nodes, edges = linear_graph()
        nodes.append(node("orphan", "agent", instruction="never runs", tools=[]))
        edges.append(edge("e9", "orphan", "text", "out", "response"))
        result = validate_graph(nodes, edges)
        unreachable = [i for i in result.warnings if i.code == "unreachable_node"]
        assert any(issue.node_id == "orphan" for issue in unreachable)


class TestIssueShape:
    def test_node_scoped_issues_carry_a_node_id(self) -> None:
        """An issue with a node_id becomes a clickable row in the builder."""
        nodes = [node("in", "input"), node("out", "output")]
        for issue in validate_graph(nodes, []).errors:
            if issue.code in {"starved_input", "tool_not_selected", "router_needs_routes"}:
                assert issue.node_id is not None

    def test_messages_are_sentences(self) -> None:
        nodes: list[Node] = []
        edges: list[Edge] = []
        for issue in validate_graph(nodes, edges).errors:
            assert issue.message.endswith(".")
            assert issue.message[0].isupper()
