from fastapi import APIRouter, Depends, Request
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.engine.runner import execute_run
from app.errors import NotFoundError
from app.llm.registry import resolve_provider
from app.models import Run, SentEmail, Workflow
from app.schemas import (
    RunRequest,
    RunResponse,
    RunSummary,
    SentEmailRead,
    Usage,
    columns_to_graph,
)
from app.tools.base import ToolContext

router = APIRouter(prefix="/api", tags=["runs"])


@router.post("/workflows/{workflow_id}/run", response_model=RunResponse)
async def run_workflow(
    workflow_id: str,
    payload: RunRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> RunResponse:
    """
    Errors *before* the run starts — no credential, unknown workflow, invalid
    graph — are HTTP errors with a code the frontend renders. Once the run has
    started, a failure comes back as **200** with a normal body whose event log
    ends in `run.error`: the partial timeline is what the user needs, and a 500
    would throw it away.
    """
    workflow = await session.get(Workflow, workflow_id)
    if workflow is None:
        raise NotFoundError("That workflow does not exist.")

    settings = get_settings()
    # Raises MissingAPIKeyError (503) or UnknownProviderError (400) before any
    # events exist, which is the right shape for a pre-run failure.
    provider = resolve_provider(request.app.state.providers, workflow.provider, settings)

    nodes, edges = columns_to_graph(workflow)
    result = await execute_run(
        nodes=nodes,
        edges=edges,
        workflow_id=workflow.id,
        workflow_name=workflow.name,
        system_prompt=workflow.system_prompt,
        model=workflow.model,
        provider=provider,
        message=payload.message,
        history=[turn.model_dump() for turn in payload.history],
        tool_ctx=ToolContext(session=session, settings=settings),
    )

    # Persisting the full log is the execution-history feature, for free.
    session.add(
        Run(
            id=result.run_id,
            workflow_id=workflow.id,
            user_message=payload.message,
            final_response=result.final_response,
            status=result.status,
            events=result.events,
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens,
            duration_ms=result.duration_ms,
        )
    )
    await session.commit()

    return RunResponse(
        run_id=result.run_id,
        final_response=result.final_response,
        events=result.events,
        usage=Usage(**result.usage.model_dump()),
        duration_ms=result.duration_ms,
    )


@router.get("/workflows/{workflow_id}/runs", response_model=list[RunSummary])
async def list_runs(
    workflow_id: str, session: AsyncSession = Depends(get_session)
) -> list[RunSummary]:
    rows = await session.exec(
        select(Run).where(Run.workflow_id == workflow_id).order_by(col(Run.created_at).desc())
    )
    return [
        RunSummary(
            run_id=row.id,
            user_message=row.user_message,
            final_response=row.final_response,
            created_at=row.created_at,
            usage=Usage(input_tokens=row.input_tokens, output_tokens=row.output_tokens),
            duration_ms=row.duration_ms,
        )
        for row in rows.all()
    ]


@router.get("/runs/{run_id}", response_model=RunResponse)
async def get_run(run_id: str, session: AsyncSession = Depends(get_session)) -> RunResponse:
    """
    Top-level, not nested under a workflow, and returns the **same** shape as
    `/run` — that is what lets replay and live share one code path in the UI.
    """
    row = await session.get(Run, run_id)
    if row is None:
        raise NotFoundError("That run does not exist.")
    return RunResponse(
        run_id=row.id,
        final_response=row.final_response,
        events=row.events,
        usage=Usage(input_tokens=row.input_tokens, output_tokens=row.output_tokens),
        duration_ms=row.duration_ms,
    )


@router.get("/emails", response_model=list[SentEmailRead])
async def list_emails(session: AsyncSession = Depends(get_session)) -> list[SentEmailRead]:
    """Global and unscoped, newest first, capped — the mock outbox."""
    rows = await session.exec(
        select(SentEmail).order_by(col(SentEmail.created_at).desc()).limit(100)
    )
    return [SentEmailRead.model_validate(row, from_attributes=True) for row in rows.all()]
