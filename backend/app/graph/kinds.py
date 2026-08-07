from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from app.graph.types import Node, NodeKindSpec, PortSpec

REGISTRY: dict[str, type[NodeKindSpec]] = {}


def register(cls: type) -> type:
    """One decorator per node kind. Adding a kind touches nothing else."""
    REGISTRY[cls.kind] = cls
    return cls


# ── Config models ───────────────────────────────────────────────────────────
# `model_json_schema()` on each of these is published at GET /api/node-kinds
# and is what the builder renders its config form from. Field descriptions are
# therefore the node kind's entire UX — there is nowhere else to put that text.


class EmptyConfig(BaseModel):
    model_config = {"extra": "allow"}


class AgentConfig(BaseModel):
    instruction: str = Field(
        default="",
        description=(
            "The task for this node. Composed with the workflow's system prompt: "
            "persona is graph-wide, task is node-local."
        ),
        json_schema_extra={"x-ui": "textarea"},
    )
    tools: list[str] = Field(
        default_factory=list,
        description="Tools this agent may call. Leave empty for a pure-reasoning step.",
    )
    max_tool_iterations: int = Field(
        default=5,
        ge=1,
        le=10,
        description="Safety cap on the tool-use loop.",
    )


class ToolNodeConfig(BaseModel):
    tool_id: str = Field(default="", description="Which registry tool to call.")
    args: dict[str, Any] = Field(
        default_factory=dict,
        description="Literal arguments for the selected tool.",
    )


class Route(BaseModel):
    label: str = Field(description="Port name, e.g. needs_research.")
    description: str = Field(
        default="",
        description="How the model decides this route applies.",
        json_schema_extra={"x-ui": "textarea"},
    )


class RouterConfig(BaseModel):
    routes: list[Route] = Field(
        default_factory=list,
        description="Each route becomes an output port. Describe when to choose it.",
    )


# ── Node kinds ──────────────────────────────────────────────────────────────
# `execute` bodies live in app/engine/nodes.py — these classes are the
# published contract (ports + config schema), which is all `/node-kinds` needs
# and all `validate.py` reads.


@register
class InputKind:
    kind: ClassVar[str] = "input"
    label: ClassVar[str] = "Input"
    description: ClassVar[str] = "Graph entry. Emits the user's turn. Exactly one per workflow."
    inputs: ClassVar[list[PortSpec]] = []
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]] = [
        PortSpec(name="message", type="text", required=True, description="The user's message."),
        PortSpec(
            name="history",
            type="json",
            required=False,
            description="Prior turns in this chat.",
        ),
    ]
    ConfigModel: ClassVar[type[BaseModel]] = EmptyConfig


@register
class AgentKind:
    kind: ClassVar[str] = "agent"
    label: ClassVar[str] = "Agent"
    description: ClassVar[str] = "Runs the tool-use loop with its own instruction and tool subset."
    inputs: ClassVar[list[PortSpec]] = [
        PortSpec(
            name="prompt",
            type="text",
            required=True,
            description="What this agent works on.",
        ),
        PortSpec(
            name="context",
            type="any",
            required=False,
            description="Extra material appended to the prompt.",
        ),
    ]
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]] = [
        PortSpec(name="text", type="text", required=True, description="The agent's final text."),
    ]
    ConfigModel: ClassVar[type[BaseModel]] = AgentConfig


@register
class ToolKind:
    kind: ClassVar[str] = "tool"
    label: ClassVar[str] = "Tool"
    description: ClassVar[str] = "Calls one registry tool deterministically — no model in the path."
    inputs: ClassVar[list[PortSpec]] = [
        PortSpec(
            name="trigger",
            type="any",
            required=False,
            description="Runs once something arrives here. The value itself is not used.",
        ),
    ]
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]] = [
        PortSpec(name="result", type="text", required=True, description="The tool's output."),
    ]
    ConfigModel: ClassVar[type[BaseModel]] = ToolNodeConfig


@register
class RouterKind:
    kind: ClassVar[str] = "router"
    label: ClassVar[str] = "Router"
    description: ClassVar[str] = (
        "Classifies its input into exactly one route. Only that branch runs."
    )
    inputs: ClassVar[list[PortSpec]] = [
        PortSpec(name="input", type="text", required=True, description="The text to classify."),
    ]
    # The only dynamic kind: one `text` port per configured route, named after
    # the route's label. The frontend resolves this in lib/ports.ts — adding a
    # second dynamic kind would force a frontend change, so don't.
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]] = "dynamic"
    ConfigModel: ClassVar[type[BaseModel]] = RouterConfig


@register
class OutputKind:
    kind: ClassVar[str] = "output"
    label: ClassVar[str] = "Output"
    description: ClassVar[str] = (
        "Terminal node. Its value is the chat reply. Exactly one per workflow."
    )
    inputs: ClassVar[list[PortSpec]] = [
        PortSpec(name="response", type="text", required=True, description="The reply to the user."),
    ]
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]] = []
    ConfigModel: ClassVar[type[BaseModel]] = EmptyConfig


SINGLETON_KINDS = ("input", "output")


# ── Port resolution ─────────────────────────────────────────────────────────


def resolve_outputs(node: Node) -> list[PortSpec]:
    """
    Static specs come straight from the kind. Only `router` is dynamic: its
    ports are one `text` port per configured route, named after `route.label`.
    """
    spec = REGISTRY.get(node.kind)
    if spec is None:
        return []
    if spec.outputs != "dynamic":
        return list(spec.outputs)
    if node.kind != "router":
        return []
    routes = RouterConfig.model_validate(node.config).routes
    return [
        PortSpec(name=route.label, type="text", required=False, description=route.description)
        for route in routes
        if route.label
    ]


def resolve_inputs(node: Node) -> list[PortSpec]:
    """
    Inputs are static in v1 — `tool` nodes take literal arguments, so there are
    no per-argument wired ports. Wiring them is the contained follow-up, and
    this is the function it would change.
    """
    spec = REGISTRY.get(node.kind)
    return list(spec.inputs) if spec else []


def node_kind_payload() -> list[dict[str, Any]]:
    """The body of GET /api/node-kinds."""
    from app.tools.registry import tool_ids

    payload: list[dict[str, Any]] = []
    for kind in ("input", "agent", "tool", "router", "output"):
        spec = REGISTRY[kind]
        schema = spec.ConfigModel.model_json_schema()
        _apply_tool_enums(kind, schema, tool_ids())
        payload.append(
            {
                "kind": spec.kind,
                "label": spec.label,
                "description": spec.description,
                "inputs": [port.model_dump() for port in spec.inputs],
                "outputs": (
                    "dynamic"
                    if spec.outputs == "dynamic"
                    else [port.model_dump() for port in spec.outputs]
                ),
                "config_schema": schema,
            }
        )
    return payload


def _apply_tool_enums(kind: str, schema: dict[str, Any], ids: list[str]) -> None:
    """
    Fill in the registered tool ids at publish time rather than hardcoding them
    in the model, so registering a tool needs no edit here.

    The shapes matter to the frontend: `agent.tools` must be array-of-enum-string
    (that is what triggers its ToolPicker), and `tool.tool_id` a plain enum
    string (a select).
    """
    properties = schema.get("properties", {})
    if kind == "agent" and "tools" in properties:
        properties["tools"]["items"] = {"type": "string", "enum": ids}
    if kind == "tool" and "tool_id" in properties:
        properties["tool_id"]["enum"] = ids
