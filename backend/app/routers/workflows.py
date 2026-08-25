from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Response, status
from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db import get_session
from app.errors import DuplicateNameError, NotFoundError
from app.graph.types import ValidationResult
from app.graph.validate import validate_graph
from app.models import Workflow
from app.schemas import (
    WorkflowInput,
    WorkflowRead,
    WorkflowSummary,
    columns_to_graph,
    graph_to_columns,
)

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


async def _load(session: AsyncSession, workflow_id: str) -> Workflow:
    row = await session.get(Workflow, workflow_id)
    if row is None:
        raise NotFoundError("That workflow does not exist.")
    return row


async def _check_name_available(
    session: AsyncSession, name: str, *, exclude_id: str | None = None
) -> None:
    """Case/whitespace-insensitive, since 'Research assistant' and 'research
    assistant ' reading as distinct is a footgun, not a feature."""
    query = select(Workflow).where(func.lower(Workflow.name) == name.strip().lower())
    if exclude_id is not None:
        query = query.where(col(Workflow.id) != exclude_id)
    existing = (await session.exec(query)).first()
    if existing is not None:
        raise DuplicateNameError(f'A workflow named "{name.strip()}" already exists.')


@router.get("", response_model=list[WorkflowSummary])
async def list_workflows(session: AsyncSession = Depends(get_session)) -> list[WorkflowSummary]:
    """Summaries, not full graphs — the list page never needs the nodes."""
    result = await session.exec(select(Workflow).order_by(col(Workflow.updated_at).desc()))
    return [WorkflowSummary.from_row(row) for row in result.all()]


@router.post("", response_model=WorkflowRead, status_code=status.HTTP_201_CREATED)
async def create_workflow(
    payload: WorkflowInput, session: AsyncSession = Depends(get_session)
) -> WorkflowRead:
    await _check_name_available(session, payload.name)
    nodes, edges = graph_to_columns(payload)
    row = Workflow(
        name=payload.name,
        description=payload.description,
        provider=payload.provider,
        model=payload.model,
        system_prompt=payload.system_prompt,
        nodes=nodes,
        edges=edges,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return WorkflowRead.from_row(row)


@router.get("/{workflow_id}", response_model=WorkflowRead)
async def get_workflow(
    workflow_id: str, session: AsyncSession = Depends(get_session)
) -> WorkflowRead:
    return WorkflowRead.from_row(await _load(session, workflow_id))


@router.put("/{workflow_id}", response_model=WorkflowRead)
async def update_workflow(
    workflow_id: str,
    payload: WorkflowInput,
    session: AsyncSession = Depends(get_session),
) -> WorkflowRead:
    row = await _load(session, workflow_id)
    await _check_name_available(session, payload.name, exclude_id=workflow_id)
    nodes, edges = graph_to_columns(payload)
    row.name = payload.name
    row.description = payload.description
    row.provider = payload.provider
    row.model = payload.model
    row.system_prompt = payload.system_prompt
    row.nodes = nodes
    row.edges = edges
    # `created_at` is preserved; only the mtime moves.
    row.updated_at = datetime.now(UTC)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return WorkflowRead.from_row(row)


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(
    workflow_id: str, session: AsyncSession = Depends(get_session)
) -> Response:
    row = await _load(session, workflow_id)
    await session.delete(row)
    await session.commit()
    # 204 with an empty body — the frontend's fetch wrapper special-cases this.
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workflow_id}/validate", response_model=ValidationResult)
async def validate_workflow(
    workflow_id: str,
    payload: WorkflowInput,
    session: AsyncSession = Depends(get_session),
) -> ValidationResult:
    """
    Validates the **submitted draft**, not the stored graph — the builder sends
    whatever is currently on screen. The id only has to exist.
    """
    await _load(session, workflow_id)
    return validate_graph(payload.nodes, payload.edges)


__all__ = ["columns_to_graph", "router"]
