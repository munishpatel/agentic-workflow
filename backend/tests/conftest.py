import pytest

from app.graph.types import Edge, EdgeEnd, Node


@pytest.fixture(autouse=True)
def isolate_credentials(monkeypatch):
    """
    Neutralise ambient credentials for the whole suite.

    Without this, a developer with real keys in `backend/.env` gets a different
    test run from CI — and `web_search` would quietly make live calls during
    unit tests. Found exactly that way. Tests that want a credential set one
    explicitly.
    """
    from app import config

    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("SEARCH_API_KEY", "")
    monkeypatch.setenv("LLM_MODEL", "claude-opus-5")
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def node(node_id: str, kind: str, **config: object) -> Node:
    return Node(id=node_id, kind=kind, label=node_id, config=config)


def edge(edge_id: str, source: str, source_port: str, target: str, target_port: str) -> Edge:
    return Edge(
        id=edge_id,
        source=EdgeEnd(node_id=source, port=source_port),
        target=EdgeEnd(node_id=target, port=target_port),
    )


def router(node_id: str = "router", *labels: str) -> Node:
    return node(
        node_id,
        "router",
        routes=[{"label": label, "description": f"choose {label}"} for label in labels],
    )


def branching_graph() -> tuple[list[Node], list[Edge]]:
    """
    The seeded shape: `input → router → {A | B} → output`, with two edges
    converging on `output.response`. Exercises the mutual-exclusion relaxation.
    """
    nodes = [
        node("in", "input"),
        router("route", "a", "b"),
        node("agent_a", "agent", instruction="do a", tools=[]),
        node("agent_b", "agent", instruction="do b", tools=[]),
        node("out", "output"),
    ]
    edges = [
        edge("e1", "in", "message", "route", "input"),
        edge("e2", "route", "a", "agent_a", "prompt"),
        edge("e3", "route", "b", "agent_b", "prompt"),
        edge("e4", "agent_a", "text", "out", "response"),
        edge("e5", "agent_b", "text", "out", "response"),
    ]
    return nodes, edges


def linear_graph() -> tuple[list[Node], list[Edge]]:
    """`input → agent → output`, the minimal valid graph."""
    nodes = [
        node("in", "input"),
        node("agent", "agent", instruction="answer", tools=[]),
        node("out", "output"),
    ]
    edges = [
        edge("e1", "in", "message", "agent", "prompt"),
        edge("e2", "agent", "text", "out", "response"),
    ]
    return nodes, edges
