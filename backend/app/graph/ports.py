from app.graph.types import Edge, Node, PortSpec, PortType

# ── Type compatibility ──────────────────────────────────────────────────────


def are_ports_compatible(source: PortType, target: PortType) -> bool:
    """
    Deliberately simple, deliberately one function: `any` connects to anything,
    identical types connect, and everything else — notably `text ↔ json` — is
    refused. Enough to catch real mistakes without inventing a type lattice.

    The frontend mirrors this rule for UX; this copy is the authority.
    """
    if source == "any" or target == "any":
        return True
    return source == target


def coerce_for_port(value: object, port_type: PortType) -> object:
    """
    Make a value presentable on a port whose type it doesn't natively match.

    Only widening is allowed — the compatibility check above has already
    refused the combinations that would need real conversion. This exists so a
    `json`-typed value crossing an `any` port arrives as something the next
    node can read, not so `text ↔ json` sneaks through the back door.
    """
    if port_type == "text" and not isinstance(value, str):
        return str(value)
    return value


# ── Reachability ────────────────────────────────────────────────────────────


def _adjacency(edges: list[Edge]) -> dict[str, list[str]]:
    graph: dict[str, list[str]] = {}
    for edge in edges:
        graph.setdefault(edge.source.node_id, []).append(edge.target.node_id)
    return graph


def has_path(edges: list[Edge], start: str, goal: str) -> bool:
    """Is there a directed path from `start` to `goal`? Terminates on cycles."""
    if start == goal:
        return True
    graph = _adjacency(edges)
    seen = {start}
    stack = [start]
    while stack:
        current = stack.pop()
        for nxt in graph.get(current, ()):
            if nxt == goal:
                return True
            if nxt in seen:
                continue
            seen.add(nxt)
            stack.append(nxt)
    return False


def detect_cycle_nodes(edges: list[Edge]) -> set[str]:
    """Every node that takes part in a cycle."""
    nodes = {end for edge in edges for end in (edge.source.node_id, edge.target.node_id)}
    return {
        node
        for node in nodes
        if any(
            edge.target.node_id == node and has_path(edges, node, edge.source.node_id)
            for edge in edges
        )
    }


# ── Router gating ───────────────────────────────────────────────────────────


def router_gates(nodes: list[Node], edges: list[Edge], node_id: str) -> set[str]:
    """
    The set of router branches a node sits behind, as `"{router_id}:{port}"`.

    Walks backwards through every incoming edge, so a node three hops past a
    router still carries that router's gate.
    """
    kind_by_id = {node.id: node.kind for node in nodes}
    gates: set[str] = set()
    seen: set[str] = set()

    def walk(current: str) -> None:
        if current in seen:
            return
        seen.add(current)
        for edge in edges:
            if edge.target.node_id != current:
                continue
            if kind_by_id.get(edge.source.node_id) == "router":
                gates.add(f"{edge.source.node_id}:{edge.source.port}")
            walk(edge.source.node_id)

    walk(node_id)
    return gates


def are_mutually_exclusive(nodes: list[Node], edges: list[Edge], a: str, b: str) -> bool:
    """
    True when no single run can activate both nodes.

    This is the predicate behind the one relaxation of single-assignment
    (frontend-imp.md §4): a second edge into an occupied input port is legal
    when the two sources sit behind **different output ports of the same
    router**, because a router activates exactly one branch.

    Without it the seeded demo graph — `input → router → {A | B} → output`,
    two edges converging on `output.response` — fails validation, and branching
    workflows become unbuildable.
    """
    node_list = [n for n in nodes if isinstance(n, Node)]
    gates_a = router_gates(node_list, edges, a)
    gates_b = router_gates(node_list, edges, b)
    for gate_a in gates_a:
        router_a, _, port_a = gate_a.partition(":")
        for gate_b in gates_b:
            router_b, _, port_b = gate_b.partition(":")
            if router_a == router_b and port_a != port_b:
                return True
    return False


# ── Port lookup helpers ─────────────────────────────────────────────────────


def find_port(ports: list[PortSpec], name: str) -> PortSpec | None:
    return next((port for port in ports if port.name == name), None)
