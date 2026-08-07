from typing import Any, ClassVar, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, Field

PortType = Literal["text", "json", "number", "boolean", "any"]
NodeKindName = Literal["input", "agent", "tool", "router", "output"]


class PortSpec(BaseModel):
    """A typed input or output on a node kind."""

    name: str
    type: PortType
    required: bool = True
    description: str = ""


class Position(BaseModel):
    x: float = 0
    y: float = 0


class Node(BaseModel):
    """
    A node in a saved graph.

    `id` is **client-generated** (`n_…`) and must round-trip verbatim — edges
    reference nodes by it. Same for `position`: losing it scrambles the user's
    canvas layout on reload.
    """

    id: str
    kind: NodeKindName
    label: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    position: Position = Field(default_factory=Position)


class EdgeEnd(BaseModel):
    node_id: str
    port: str


class Edge(BaseModel):
    id: str
    source: EdgeEnd
    target: EdgeEnd


class ValidationIssue(BaseModel):
    """
    `code` is shown verbatim in the builder's validation banner, and an issue
    carrying a `node_id` becomes a clickable row that selects and rings that
    node — so set it whenever there is one.
    """

    code: str
    message: str
    node_id: str | None = None
    edge_id: str | None = None


class ValidationResult(BaseModel):
    """
    Response-only, so `errors` and `warnings` carry no defaults: the server
    always sends both, and a default would publish them as optional in the
    OpenAPI, forcing every frontend call site to null-check a field that is
    never absent.
    """

    valid: bool
    errors: list[ValidationIssue]
    warnings: list[ValidationIssue]


@runtime_checkable
class NodeKindSpec(Protocol):
    """
    What every node kind must declare.

    `ConfigModel.model_json_schema()` is published at `GET /api/node-kinds` and
    is what the builder renders its config form from — one Pydantic model
    serving as the runtime validator *and* the UI schema is the mechanism
    behind "adding a node kind needs no frontend change".
    """

    kind: ClassVar[str]
    label: ClassVar[str]
    description: ClassVar[str]
    inputs: ClassVar[list[PortSpec]]
    outputs: ClassVar[list[PortSpec] | Literal["dynamic"]]
    ConfigModel: ClassVar[type[BaseModel]]

    async def execute(self, ctx: Any) -> dict[str, Any]:
        """Returns a mapping of output port name → value."""
        ...
