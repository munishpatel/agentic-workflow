from typing import Any

from app.tools.base import Tool

REGISTRY: dict[str, Tool] = {}


def register(cls: type) -> type:
    """
    Adding a tool = one module + one decorator. Nothing else in the system
    changes: `/api/tools` picks it up, the builder's ToolPicker lists it, and
    agents can call it. That sentence is the extensibility claim, so keep it
    literally true.
    """
    REGISTRY[cls.id] = cls()
    return cls


def get_tool(tool_id: str) -> Tool | None:
    return REGISTRY.get(tool_id)


def tool_ids() -> list[str]:
    return list(REGISTRY)


def tool_metadata() -> list[dict[str, Any]]:
    """
    The body of `GET /api/tools`.

    `Input.model_json_schema()` serves three consumers at once: the schema the
    model sees, the runtime validator in `dispatch`, and the builder's `args`
    sub-form. One definition, three uses.
    """
    return [
        {
            "id": tool.id,
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.Input.model_json_schema(),
        }
        for tool in REGISTRY.values()
    ]


def tool_schemas(tool_ids_wanted: list[str]) -> list[dict[str, Any]]:
    """Model-facing schemas for the subset an agent node has enabled."""
    schemas = []
    for tool_id in tool_ids_wanted:
        tool = REGISTRY.get(tool_id)
        if tool is None:
            continue
        schemas.append(
            {
                "name": tool.id,
                "description": tool.description,
                "input_schema": tool.Input.model_json_schema(),
            }
        )
    return schemas


# Importing the tool modules is what runs their @register decorators. Kept at
# the bottom so `register` above is defined by the time they load.
from app.tools import calculator, current_datetime, send_email, web_search  # noqa: E402,F401
