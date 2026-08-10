import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from app.engine.agent_loop import (
    build_history,
    compose_system_prompt,
    rejection_result,
    run_agent_loop,
)
from app.engine.checkpoint import (
    ApprovalDecision,
    LoopPaused,
    NodePause,
    NodePaused,
    PendingCall,
    RunCheckpoint,
)
from app.engine.events import EventBus, truncate_preview
from app.engine.router import decide_route
from app.errors import NodeLimitError, RunError, StarvedOutputError, ValidationFailedError
from app.graph.kinds import (
    AgentConfig,
    RouterConfig,
    ToolNodeConfig,
    resolve_inputs,
    resolve_outputs,
)
from app.graph.ports import coerce_for_port, find_port
from app.graph.types import Edge, Node
from app.graph.validate import validate_graph
from app.llm.base import LLMProvider, Usage
from app.tools.base import ToolContext
from app.tools.dispatch import dispatch
from app.tools.registry import requires_approval

logger = logging.getLogger("app.engine.scheduler")

MAX_NODE_EXECUTIONS = 24
NODE_TIMEOUT_SECONDS = 180


@dataclass
class RunOutcome:
    final_response: str = ""
    usage: Usage = field(default_factory=Usage)
    duration_ms: int = 0
    status: str = "ok"
    # Set only when `status == "paused"`: everything needed to finish this run
    # once a human has ruled on the gated calls.
    checkpoint: RunCheckpoint | None = None


@dataclass
class _State:
    values: dict[tuple[str, str], Any] = field(default_factory=dict)
    done: set[str] = field(default_factory=set)
    pruned: set[str] = field(default_factory=set)
    executions: int = 0
    usage: Usage = field(default_factory=Usage)
    final_response: str | None = None


async def run_graph(
    *,
    nodes: list[Node],
    edges: list[Edge],
    workflow_name: str,
    workflow_id: str,
    system_prompt: str,
    model: str,
    provider: LLMProvider,
    message: str,
    history: list[dict[str, str]],
    bus: EventBus,
    tool_ctx: ToolContext,
    # The key `workflow.provider` holds, not the instance's own `id`. It is the
    # only one that round-trips: resuming has to look the provider back up in
    # the registry, and that lookup is keyed by the workflow's value.
    provider_id: str = "",
    resume: RunCheckpoint | None = None,
    decisions: dict[str, ApprovalDecision] | None = None,
) -> RunOutcome:
    """
    Data-flow execution over the DAG.

    Not a `for` loop over a list — that is the whole argument for the graph
    model. Fan-out and join fall out of this shape with no extra code, and
    branch pruning has somewhere to live.

    A gated tool call suspends the whole run: the node raises `NodePaused`, and
    because a batch is gathered before anything is delivered, its siblings still
    finish and land in `state` first. That ordering is the point — pausing must
    cost the run nothing it has already earned, or a slow reviewer turns every
    parallel branch into wasted tokens.
    """
    started = time.perf_counter()

    validation = validate_graph(nodes, edges)
    if validation.errors:
        raise ValidationFailedError(
            "This workflow cannot run until its graph errors are fixed.",
            details=[issue.model_dump() for issue in validation.errors],
        )

    by_id = {node.id: node for node in nodes}

    if resume is None:
        state = _State()
        bus.emit("run.start", {"workflow_id": workflow_id, "workflow_name": workflow_name})
        entry = next(node for node in nodes if node.kind == "input")
        state.values[(entry.id, "__seed__")] = message
        # node_id → the pause it is resuming from. Empty on a fresh run.
        resuming: dict[str, NodePause] = {}
        elapsed_before = 0
    else:
        state = _restore_state(resume)
        resuming = {pause.node_id: pause for pause in resume.paused}
        elapsed_before = resume.elapsed_ms

    verdicts = dict(decisions or {})

    while True:
        if resuming:
            # The resume batch: only the nodes that were holding, and they are
            # ready by definition — their inputs were satisfied before the pause.
            ready = [by_id[node_id] for node_id in resuming if node_id in by_id]
        else:
            ready = [
                node
                for node in nodes
                if node.id not in state.done
                and node.id not in state.pruned
                and _is_ready(node, edges, state)
            ]
            state.executions += len(ready)
            if state.executions > MAX_NODE_EXECUTIONS:
                raise NodeLimitError(
                    f"This workflow ran more than {MAX_NODE_EXECUTIONS} nodes. "
                    "Check for a branch that fans out further than intended."
                )
        if not ready:
            break

        results = await asyncio.gather(
            *(
                _run_node(
                    node=node,
                    edges=edges,
                    state=state,
                    provider=provider,
                    model=model,
                    system_prompt=system_prompt,
                    message=message,
                    history=history,
                    bus=bus,
                    tool_ctx=tool_ctx,
                    resume=resuming.get(node.id),
                    decisions=verdicts,
                )
                for node in ready
            ),
            return_exceptions=True,
        )
        # Both are single-use: a verdict settles one call, and a resumed node is
        # an ordinary node from here on.
        resuming = {}
        verdicts = {}

        pauses: list[NodePause] = []
        failure: BaseException | None = None
        for node, result in zip(ready, results, strict=True):
            if isinstance(result, NodePaused):
                pauses.append(result.pause)
                continue
            if isinstance(result, BaseException):
                # Keep going rather than raising here — the siblings that
                # succeeded still have values worth delivering, and the event
                # log is the thing the user reads afterwards.
                failure = failure or result
                continue
            state.done.add(node.id)
            _deliver(node, result, edges, by_id, state, bus)
            if node.kind == "router":
                chosen = next(iter(result), "")
                _prune_branches(node, chosen, nodes, edges, state, bus)
            if node.kind == "output":
                state.final_response = str(result.get("__final__", ""))

        if failure is not None:
            # A failure anywhere in the batch outranks a pause: there is no
            # point asking a human about a send whose run is already dead.
            raise failure

        if pauses:
            return RunOutcome(
                usage=state.usage,
                duration_ms=elapsed_before + int((time.perf_counter() - started) * 1000),
                status="paused",
                checkpoint=_checkpoint(
                    nodes=nodes,
                    edges=edges,
                    workflow_id=workflow_id,
                    workflow_name=workflow_name,
                    provider_id=provider_id,
                    model=model,
                    system_prompt=system_prompt,
                    message=message,
                    history=history,
                    state=state,
                    pauses=pauses,
                    elapsed_ms=elapsed_before + int((time.perf_counter() - started) * 1000),
                ),
            )

    if state.final_response is None:
        starved = _first_starved_node(nodes, edges, state)
        raise StarvedOutputError(
            "The workflow finished without producing a reply — the output node never "
            "received a value.",
            details={"node_id": starved},
        )

    duration_ms = elapsed_before + int((time.perf_counter() - started) * 1000)
    return RunOutcome(
        final_response=state.final_response,
        usage=state.usage,
        duration_ms=duration_ms,
    )


def _restore_state(checkpoint: RunCheckpoint) -> _State:
    """The scheduler's state as it stood when the run paused."""
    state = _State()
    state.values = {(node_id, port): value for node_id, port, value in checkpoint.values}
    state.done = set(checkpoint.done)
    state.pruned = set(checkpoint.pruned)
    state.executions = checkpoint.executions
    state.usage = checkpoint.usage
    state.final_response = checkpoint.final_response
    return state


def _checkpoint(
    *,
    nodes: list[Node],
    edges: list[Edge],
    workflow_id: str,
    workflow_name: str,
    provider_id: str,
    model: str,
    system_prompt: str,
    message: str,
    history: list[dict[str, str]],
    state: _State,
    pauses: list[NodePause],
    elapsed_ms: int,
) -> RunCheckpoint:
    """
    Freeze the run. The graph travels *with* the checkpoint rather than being
    re-read on resume — see `RunCheckpoint` for why that is a correctness
    requirement and not an optimisation.
    """
    return RunCheckpoint(
        workflow_id=workflow_id,
        workflow_name=workflow_name,
        provider_id=provider_id,
        model=model,
        system_prompt=system_prompt,
        message=message,
        history=history,
        nodes=nodes,
        edges=edges,
        values=[(node_id, port, value) for (node_id, port), value in state.values.items()],
        done=sorted(state.done),
        pruned=sorted(state.pruned),
        executions=state.executions,
        usage=state.usage,
        final_response=state.final_response,
        elapsed_ms=elapsed_ms,
        paused=pauses,
    )


def _is_ready(node: Node, edges: list[Edge], state: _State) -> bool:
    """
    An input port is satisfied when **any** incoming edge has delivered — not
    all of them.

    With convergent router branches exactly one edge will ever deliver, so
    waiting for all of them deadlocks the output node. Waiting on the *sources*
    instead is also wrong for the same reason.
    """
    if node.kind == "input":
        return (node.id, "__seed__") in state.values

    for port in resolve_inputs(node):
        incoming = [
            edge
            for edge in edges
            if edge.target.node_id == node.id and edge.target.port == port.name
        ]
        if not incoming:
            # No wiring at all: required ports are a validation error, so by
            # here an unwired port must be optional.
            continue
        if (node.id, port.name) in state.values:
            continue
        if not port.required:
            # Optional and unfilled — but only proceed once every source that
            # could still fill it is settled, or we would race the value.
            if all(
                edge.source.node_id in state.done or edge.source.node_id in state.pruned
                for edge in incoming
            ):
                continue
            return False
        return False
    return True


async def _run_node(
    *,
    node: Node,
    edges: list[Edge],
    state: _State,
    provider: LLMProvider,
    model: str,
    system_prompt: str,
    message: str,
    history: list[dict[str, str]],
    bus: EventBus,
    tool_ctx: ToolContext,
    resume: NodePause | None = None,
    decisions: dict[str, ApprovalDecision] | None = None,
) -> dict[str, Any]:
    # A resumed node emits no second `node.start`. One node that paused is one
    # step in the timeline, not two — and the frontend's reducer keys its groups
    # by node id, so a second start would split the node's own tool calls across
    # two boxes with the approval sitting between them.
    if resume is None:
        bus.emit("node.start", {"kind": node.kind, "label": node.label}, node_id=node.id)
    started = time.perf_counter()
    try:
        async with asyncio.timeout(NODE_TIMEOUT_SECONDS):
            outputs = await _execute(
                node=node,
                state=state,
                provider=provider,
                model=model,
                system_prompt=system_prompt,
                message=message,
                history=history,
                bus=bus,
                tool_ctx=tool_ctx,
                resume=resume,
                decisions=decisions,
            )
    except TimeoutError as exc:
        raise RunError(
            f"{node.label or node.id} took longer than {NODE_TIMEOUT_SECONDS} seconds."
        ) from exc

    # For a resumed node this times the segment after the verdict, not the wall
    # clock since `node.start`. However long the reviewer took is their latency,
    # not the node's, and folding it in would make every gated node look slow.
    ms = int((time.perf_counter() - started) * 1000)
    bus.emit("node.end", {"kind": node.kind, "label": node.label, "ms": ms}, node_id=node.id)
    return outputs


async def _execute(
    *,
    node: Node,
    state: _State,
    provider: LLMProvider,
    model: str,
    system_prompt: str,
    message: str,
    history: list[dict[str, str]],
    bus: EventBus,
    tool_ctx: ToolContext,
    resume: NodePause | None = None,
    decisions: dict[str, ApprovalDecision] | None = None,
) -> dict[str, Any]:
    if node.kind == "input":
        return {"message": message, "history": history}

    if node.kind == "output":
        value = state.values.get((node.id, "response"), "")
        return {"__final__": value if isinstance(value, str) else str(value)}

    if node.kind == "agent":
        config = AgentConfig.model_validate(node.config)
        prompt = str(state.values.get((node.id, "prompt"), message))
        context = state.values.get((node.id, "context"))
        if context:
            prompt = f"{prompt}\n\n## Additional context\n{context}"
        try:
            turn = await run_agent_loop(
                provider=provider,
                model=model,
                system=compose_system_prompt(system_prompt, node.label, config.instruction),
                prompt=prompt,
                history=build_history(history),
                tool_ids=config.tools,
                max_iterations=config.max_tool_iterations,
                bus=bus,
                node_id=node.id,
                tool_ctx=tool_ctx,
                resume=resume.loop if resume is not None else None,
                decisions=decisions,
            )
        except LoopPaused as paused:
            raise NodePaused(
                NodePause(node_id=node.id, kind="agent", loop=paused.checkpoint)
            ) from None
        state.usage = state.usage + turn.usage
        return {"text": turn.text}

    if node.kind == "router":
        config = RouterConfig.model_validate(node.config)
        value = str(state.values.get((node.id, "input"), message))
        decision = await decide_route(
            provider=provider,
            model=model,
            system=system_prompt,
            config=config,
            value=value,
            bus=bus,
            node_id=node.id,
            label=node.label,
        )
        state.usage = state.usage + decision.usage
        # Exactly one output port carries a value; the scheduler prunes the rest.
        return {decision.chosen: value}

    if node.kind == "tool":
        config = ToolNodeConfig.model_validate(node.config)
        call_id = f"node_{node.id}"

        if resume is not None:
            # Second visit: a human has ruled on this node's single call.
            return await _settle_tool_node(
                node=node,
                config=config,
                call_id=call_id,
                decisions=decisions or {},
                bus=bus,
                tool_ctx=tool_ctx,
            )

        bus.emit(
            "tool.call",
            {"call_id": call_id, "tool": config.tool_id, "input": config.args},
            node_id=node.id,
        )
        # The gate is a property of the tool, so it applies here exactly as it
        # does inside an agent — a literal `send_email` node wired into a graph
        # is not a way around the review.
        if requires_approval(config.tool_id):
            bus.emit(
                "approval.required",
                {"call_id": call_id, "tool": config.tool_id, "input": config.args},
                node_id=node.id,
            )
            raise NodePaused(
                NodePause(
                    node_id=node.id,
                    kind="tool",
                    call=PendingCall(
                        call_id=call_id,
                        node_id=node.id,
                        tool=config.tool_id,
                        input=config.args,
                    ),
                )
            )

        outcome = await dispatch(config.tool_id, config.args, tool_ctx)
        bus.emit(
            "tool.result",
            {
                "call_id": call_id,
                "tool": config.tool_id,
                "output": outcome.result.output,
                "is_error": outcome.result.is_error,
                "ms": outcome.ms,
            },
            node_id=node.id,
        )
        return {"result": outcome.result.output}

    raise RunError(f"“{node.kind}” is not a node kind this server can execute.")


async def _settle_tool_node(
    *,
    node: Node,
    config: ToolNodeConfig,
    call_id: str,
    decisions: dict[str, ApprovalDecision],
    bus: EventBus,
    tool_ctx: ToolContext,
) -> dict[str, Any]:
    """
    A gated tool node, after the verdict.

    A rejection is not a run failure: it produces an error-flagged result that
    flows down the node's `result` port like any other. That is the same shape
    a tool that raised would produce, so downstream nodes need no new case —
    and the graph gets to decide what a decline means rather than the engine
    deciding for it.
    """
    decision = decisions.get(call_id)
    approved = decision is not None and decision.approved
    note = decision.note if decision is not None else ""
    bus.emit(
        "approval.decision",
        {"call_id": call_id, "tool": config.tool_id, "approved": approved, "note": note},
        node_id=node.id,
    )

    if approved:
        outcome = await dispatch(config.tool_id, config.args, tool_ctx)
        result, ms = outcome.result, outcome.ms
    else:
        result, ms = rejection_result(config.tool_id, note), 0

    bus.emit(
        "tool.result",
        {
            "call_id": call_id,
            "tool": config.tool_id,
            "output": result.output,
            "is_error": result.is_error,
            "ms": ms,
        },
        node_id=node.id,
    )
    return {"result": result.output}


def _deliver(
    node: Node,
    outputs: dict[str, Any],
    edges: list[Edge],
    by_id: dict[str, Node],
    state: _State,
    bus: EventBus,
) -> None:
    """Push each produced value along its outgoing edges, one event per hop."""
    port_specs = {port.name: port for port in resolve_outputs(node)}
    for port_name, value in outputs.items():
        if port_name.startswith("__"):
            continue
        for edge in edges:
            if edge.source.node_id != node.id or edge.source.port != port_name:
                continue
            target = by_id.get(edge.target.node_id)
            if target is None:
                continue
            target_port = find_port(resolve_inputs(target), edge.target.port)
            port_type = target_port.type if target_port else "any"
            delivered = coerce_for_port(value, port_type)
            state.values[(edge.target.node_id, edge.target.port)] = delivered
            bus.emit(
                "edge.transfer",
                {
                    "source": {"node_id": node.id, "port": port_name},
                    "target": {"node_id": edge.target.node_id, "port": edge.target.port},
                    "port_type": port_specs[port_name].type if port_name in port_specs else "any",
                    "preview": truncate_preview(delivered),
                },
            )


def _prune_branches(
    router: Node,
    chosen_port: str,
    nodes: list[Node],
    edges: list[Edge],
    state: _State,
    bus: EventBus,
) -> None:
    """
    Pruning is transitive **and conditional**.

    A node is pruned only if every incoming edge to a required port comes from
    a pruned node — a node still reachable by a live path survives. Concretely:
    in `input → router → {A | B} → output`, choosing A prunes B but must NOT
    prune `output`, which still has a live edge from A. Getting this wrong is
    the subtlest bug in the engine.
    """
    by_id = {node.id: node for node in nodes}
    dead_edges = {
        edge.id
        for edge in edges
        if edge.source.node_id == router.id and edge.source.port != chosen_port
    }

    changed = True
    while changed:
        changed = False
        for node in nodes:
            if node.id in state.pruned or node.id in state.done or node.kind == "input":
                continue
            incoming = [edge for edge in edges if edge.target.node_id == node.id]
            if not incoming:
                continue
            # Live if any incoming edge is neither a pruned branch nor from a
            # pruned node.
            has_live_source = any(
                edge.id not in dead_edges and edge.source.node_id not in state.pruned
                for edge in incoming
            )
            if has_live_source:
                continue
            state.pruned.add(node.id)
            changed = True
            reason = (
                f"Router chose {chosen_port}"
                if any(edge.id in dead_edges for edge in incoming)
                else "Every path to this node was pruned"
            )
            bus.emit(
                "node.skipped",
                {"kind": node.kind, "label": node.label, "reason": reason},
                node_id=node.id,
            )
            # Mark this node's own outgoing edges dead so pruning cascades.
            dead_edges.update(edge.id for edge in edges if edge.source.node_id == node.id)
            _ = by_id  # kept for readability of the loop above


def _first_starved_node(nodes: list[Node], edges: list[Edge], state: _State) -> str | None:
    """Which node stalled — so the error can point the user at it."""
    for node in nodes:
        if node.id in state.done or node.id in state.pruned:
            continue
        for port in resolve_inputs(node):
            if port.required and (node.id, port.name) not in state.values:
                return node.id
    output = next((node for node in nodes if node.kind == "output"), None)
    return output.id if output else None
