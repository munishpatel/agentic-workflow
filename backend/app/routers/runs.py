from fastapi import APIRouter, Depends, Request
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.engine.checkpoint import ApprovalDecision, RunCheckpoint
from app.engine.runner import RunResult, execute_run, resume_run
from app.errors import MissingDecisionError, NotFoundError, RunNotPausedError
from app.llm.registry import resolve_provider
from app.models import Run, SentEmail, Workflow
from app.schemas import (
    PendingApproval,
    ResumeRunRequest,
    RunRequest,
    RunResponse,
    RunSummary,
    SentEmailRead,
    Usage,
    columns_to_graph,
)
from app.tools.base import ToolContext

router = APIRouter(prefix="/api", tags=["runs"])


def _response(result: RunResult) -> RunResponse:
    """
    One shape for starting, resuming and replaying.

    Keeping `/run`, `/resume` and `GET /runs/{id}` identical on the wire is what
    lets the frontend render all three through the same reducer — a resumed run
    is not a special case it has to know about.
    """
    return RunResponse(
        run_id=result.run_id,
        final_response=result.final_response,
        events=result.events,
        usage=Usage(**result.usage.model_dump()),
        duration_ms=result.duration_ms,
        status=result.status,
        pending_approvals=[
            PendingApproval(
                call_id=call.call_id,
                node_id=call.node_id,
                tool=call.tool,
                input=call.input,
            )
            for call in result.pending_approvals
        ],
    )


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

    A run that hits a gated tool call also comes back **200**, with
    `status="paused"` and the held calls in `pending_approvals`. Nothing has
    gone wrong — it is waiting for `POST /api/runs/{run_id}/resume`.
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
        provider_id=workflow.provider,
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
            checkpoint=(
                result.checkpoint.model_dump(mode="json") if result.checkpoint is not None else None
            ),
        )
    )
    await session.commit()

    return _response(result)


@router.post("/runs/{run_id}/resume", response_model=RunResponse)
async def resume_paused_run(
    run_id: str,
    payload: ResumeRunRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> RunResponse:
    """
    Rule on the gated calls and let the run finish.

    The verdicts are matched against the checkpoint, not taken on trust: a
    decision for a call this run is not holding is ignored, and a held call with
    no decision is a 422. Between them, "approve" can only ever mean the exact
    call the reviewer was shown.

    A resume can pause again — a workflow may gate more than one call — in which
    case this returns `status="paused"` with the next batch, and the row keeps
    a fresh checkpoint.
    """
    row = await session.get(Run, run_id)
    if row is None:
        raise NotFoundError("That run does not exist.")
    if row.status != "paused" or row.checkpoint is None:
        raise RunNotPausedError("That run is not waiting for an approval.")

    checkpoint = RunCheckpoint.model_validate(row.checkpoint)
    held = {call.call_id for call in checkpoint.pending_calls}
    given = {decision.call_id for decision in payload.decisions}
    missing = held - given
    if missing:
        raise MissingDecisionError(
            "Every held tool call needs an approve-or-reject decision before this run "
            "can continue.",
            details={"missing_call_ids": sorted(missing)},
        )

    decisions = {
        decision.call_id: ApprovalDecision(
            call_id=decision.call_id,
            approved=decision.approved,
            note=decision.note,
        )
        for decision in payload.decisions
        if decision.call_id in held
    }

    settings = get_settings()
    provider = resolve_provider(request.app.state.providers, checkpoint.provider_id, settings)

    result = await resume_run(
        run_id=run_id,
        checkpoint=checkpoint,
        decisions=decisions,
        provider=provider,
        prior_events=row.events,
        tool_ctx=ToolContext(session=session, settings=settings),
    )

    row.final_response = result.final_response
    row.status = result.status
    row.events = result.events
    row.input_tokens = result.usage.input_tokens
    row.output_tokens = result.usage.output_tokens
    row.duration_ms = result.duration_ms
    # Cleared unless the run paused again — a finished run must not be
    # resumable, or approving twice would send twice.
    row.checkpoint = (
        result.checkpoint.model_dump(mode="json") if result.checkpoint is not None else None
    )
    session.add(row)
    await session.commit()

    return _response(result)


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
            status=row.status,
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
    # A replayed run that is still paused shows its held calls, so reopening a
    # workflow does not lose an approval someone walked away from.
    pending = (
        RunCheckpoint.model_validate(row.checkpoint).pending_calls
        if row.status == "paused" and row.checkpoint is not None
        else []
    )
    return RunResponse(
        run_id=row.id,
        final_response=row.final_response,
        events=row.events,
        usage=Usage(input_tokens=row.input_tokens, output_tokens=row.output_tokens),
        duration_ms=row.duration_ms,
        status=row.status if row.status in ("ok", "error", "paused") else "ok",
        pending_approvals=[
            PendingApproval(
                call_id=call.call_id,
                node_id=call.node_id,
                tool=call.tool,
                input=call.input,
            )
            for call in pending
        ],
    )


@router.get("/emails", response_model=list[SentEmailRead])
async def list_emails(session: AsyncSession = Depends(get_session)) -> list[SentEmailRead]:
    """Global and unscoped, newest first, capped — the mock outbox."""
    rows = await session.exec(
        select(SentEmail).order_by(col(SentEmail.created_at).desc()).limit(100)
    )
    return [SentEmailRead.model_validate(row, from_attributes=True) for row in rows.all()]
