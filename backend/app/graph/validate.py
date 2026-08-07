from app.graph.kinds import REGISTRY, resolve_inputs, resolve_outputs
from app.graph.ports import (
    are_mutually_exclusive,
    are_ports_compatible,
    detect_cycle_nodes,
    find_port,
    has_path,
)
from app.graph.types import Edge, Node, ValidationIssue, ValidationResult


def validate_graph(nodes: list[Node], edges: list[Edge]) -> ValidationResult:
    """
    The authority on graph correctness. The frontend mirrors these rules to make
    bad connections un-draggable; when the two disagree, this one is right.

    Codes are part of the contract — the builder renders `code` verbatim and
    turns any issue carrying a `node_id` into a clickable row that focuses that
    node, so set `node_id`/`edge_id` whenever there is one, and write `message`
    as a sentence naming the fix.
    """
    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []

    by_id = {node.id: node for node in nodes}
    input_nodes = [node for node in nodes if node.kind == "input"]
    output_nodes = [node for node in nodes if node.kind == "output"]

    # ── Singletons ──────────────────────────────────────────────────────────
    if not input_nodes:
        errors.append(
            ValidationIssue(
                code="missing_input_node",
                message="The workflow needs an input node.",
            )
        )
    for node in input_nodes[1:]:
        errors.append(
            ValidationIssue(
                code="duplicate_input_node",
                message="Only one input node is allowed.",
                node_id=node.id,
            )
        )

    if not output_nodes:
        errors.append(
            ValidationIssue(
                code="missing_output_node",
                message=(
                    "The workflow needs an output node — without one there is nothing "
                    "to reply with."
                ),
            )
        )
    for node in output_nodes[1:]:
        errors.append(
            ValidationIssue(
                code="duplicate_output_node",
                message="Only one output node is allowed.",
                node_id=node.id,
            )
        )

    for node in nodes:
        if node.kind not in REGISTRY:
            errors.append(
                ValidationIssue(
                    code="unknown_node_kind",
                    message=f"“{node.kind}” is not a node kind this server publishes.",
                    node_id=node.id,
                )
            )

    # ── Edges ───────────────────────────────────────────────────────────────
    for edge in edges:
        source_node = by_id.get(edge.source.node_id)
        target_node = by_id.get(edge.target.node_id)
        if source_node is None or target_node is None:
            errors.append(
                ValidationIssue(
                    code="dangling_edge",
                    message="This connection points at a node that no longer exists.",
                    edge_id=edge.id,
                )
            )
            continue

        source_port = find_port(resolve_outputs(source_node), edge.source.port)
        target_port = find_port(resolve_inputs(target_node), edge.target.port)
        if source_port is None or target_port is None:
            errors.append(
                ValidationIssue(
                    code="unknown_port",
                    message=(
                        f"“{edge.source.port} → {edge.target.port}” refers to a port "
                        "that does not exist."
                    ),
                    edge_id=edge.id,
                    node_id=target_node.id,
                )
            )
            continue

        if not are_ports_compatible(source_port.type, target_port.type):
            errors.append(
                ValidationIssue(
                    code="port_type_mismatch",
                    message=(
                        f"{source_node.label or source_node.id}.{source_port.name} is "
                        f"{source_port.type} but {target_node.label or target_node.id}."
                        f"{target_port.name} expects {target_port.type}."
                    ),
                    edge_id=edge.id,
                    node_id=target_node.id,
                )
            )

    # ── Occupied inputs, with the router relaxation ────────────────────────
    # Inputs are single-assignment *except* when the competing sources sit
    # behind different output ports of the same router: a router activates one
    # branch, so those edges can never both deliver. This is what makes the
    # seeded `input → router → {A | B} → output` graph legal.
    incoming: dict[tuple[str, str], list[Edge]] = {}
    for edge in edges:
        incoming.setdefault((edge.target.node_id, edge.target.port), []).append(edge)

    for (node_id, port_name), port_edges in incoming.items():
        if len(port_edges) < 2:
            continue
        target_node = by_id.get(node_id)
        if target_node is None:
            continue
        for index, edge in enumerate(port_edges):
            for other in port_edges[index + 1 :]:
                if are_mutually_exclusive(nodes, edges, edge.source.node_id, other.source.node_id):
                    continue
                errors.append(
                    ValidationIssue(
                        code="port_already_connected",
                        message=(
                            f"“{port_name}” on {target_node.label or node_id} receives data "
                            "from two sources that can both run. Remove one, or feed it "
                            "from different router branches."
                        ),
                        edge_id=other.id,
                        node_id=node_id,
                    )
                )

    # ── Per-node checks ────────────────────────────────────────────────────
    for node in nodes:
        if node.kind not in REGISTRY:
            continue
        inputs = resolve_inputs(node)
        outputs = resolve_outputs(node)

        for port in inputs:
            if not port.required:
                continue
            if not any(
                edge.target.node_id == node.id and edge.target.port == port.name for edge in edges
            ):
                errors.append(
                    ValidationIssue(
                        code="starved_input",
                        message=(
                            f"{node.label or node.id} needs something connected to its "
                            f"“{port.name}” input."
                        ),
                        node_id=node.id,
                    )
                )

        if (
            node.kind != "output"
            and outputs
            and not any(edge.source.node_id == node.id for edge in edges)
        ):
            warnings.append(
                ValidationIssue(
                    code="dangling_output",
                    message=(f"{node.label or node.id} produces a value that nothing consumes."),
                    node_id=node.id,
                )
            )

        if node.kind == "router" and len(outputs) < 2:
            errors.append(
                ValidationIssue(
                    code="router_needs_routes",
                    message=(
                        f"{node.label or node.id} needs at least two routes to be worth "
                        "branching on."
                    ),
                    node_id=node.id,
                )
            )

        if node.kind == "agent" and not str(node.config.get("instruction", "")).strip():
            warnings.append(
                ValidationIssue(
                    code="empty_instruction",
                    message=(
                        f"{node.label or node.id} has no instruction — it will fall back to "
                        "the workflow system prompt alone."
                    ),
                    node_id=node.id,
                )
            )

        if node.kind == "tool" and not str(node.config.get("tool_id", "")).strip():
            errors.append(
                ValidationIssue(
                    code="tool_not_selected",
                    message=f"{node.label or node.id} has no tool selected.",
                    node_id=node.id,
                )
            )

        if (
            node.kind != "input"
            and input_nodes
            and not any(has_path(edges, entry.id, node.id) for entry in input_nodes)
        ):
            warnings.append(
                ValidationIssue(
                    code="unreachable_node",
                    message=(
                        f"{node.label or node.id} cannot be reached from the input node, "
                        "so it will never run."
                    ),
                    node_id=node.id,
                )
            )

    # ── Cycles ─────────────────────────────────────────────────────────────
    for node_id in sorted(detect_cycle_nodes(edges)):
        node = by_id.get(node_id)
        errors.append(
            ValidationIssue(
                code="cycle_detected",
                message=(
                    f"{(node.label if node else None) or node_id} takes part in a cycle. "
                    "Workflows must be acyclic."
                ),
                node_id=node_id,
            )
        )

    return ValidationResult(valid=not errors, errors=errors, warnings=warnings)
