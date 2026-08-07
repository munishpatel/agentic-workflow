from typing import Any

from fastapi import APIRouter

from app.config import get_settings
from app.graph.kinds import node_kind_payload
from app.schemas import ProviderMeta, ToolMeta
from app.tools.registry import tool_metadata

router = APIRouter(prefix="/api", tags=["registry"])


@router.get("/node-kinds")
async def list_node_kinds() -> list[dict[str, Any]]:
    """
    Port contracts and config JSON Schemas. The builder is *generated* from
    this — which is what makes adding a node kind here need no frontend change.
    """
    return node_kind_payload()


@router.get("/tools", response_model=list[ToolMeta])
async def list_tools() -> list[ToolMeta]:
    return [ToolMeta(**meta) for meta in tool_metadata()]


KNOWN_ANTHROPIC_MODELS = (
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
)


@router.get("/providers", response_model=list[ProviderMeta])
async def list_providers() -> list[ProviderMeta]:
    """
    The configured `LLM_MODEL` is listed **first**.

    The builder picks `models[0]` for a newly created workflow, so this is what
    makes the setting actually take effect. An unrecognised value is still
    offered rather than dropped — configuring a model this build has not heard
    of should not silently switch workflows to a different one.
    """
    settings = get_settings()
    configured = settings.llm_model
    models = [configured, *(m for m in KNOWN_ANTHROPIC_MODELS if m != configured)]
    return [ProviderMeta(id="anthropic", label="Anthropic", models=models)]
