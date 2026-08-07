from dataclasses import dataclass, field
from typing import Any, ClassVar, Protocol, runtime_checkable

from pydantic import BaseModel


@dataclass
class ToolContext:
    """
    What a tool is allowed to reach. Deliberately narrow — a tool gets the run
    it belongs to and, if it needs one, a database session; it never gets the
    provider, the scheduler, or the event bus.
    """

    run_id: str | None = None
    session: Any = None
    settings: Any = None
    extras: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolResult:
    """
    `output` is **always a string** — tools return prose or pretty-printed
    JSON. The model consumes strings anyway, and one type across every tool
    avoids per-tool inconsistency in the timeline (frontend-imp.md §9.4).
    """

    output: str
    is_error: bool = False


@runtime_checkable
class Tool(Protocol):
    id: ClassVar[str]
    name: ClassVar[str]
    # Say WHEN to call it, not just what it does — an under-described tool is
    # the most common cause of an agent that never calls it.
    description: ClassVar[str]
    Input: ClassVar[type[BaseModel]]

    async def execute(self, args: BaseModel, ctx: ToolContext) -> ToolResult: ...
