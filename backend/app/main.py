import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import create_tables
from app.errors import AppError
from app.routers import registry as registry_router
from app.routers import runs as runs_router
from app.routers import workflows as workflows_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("app")

settings = get_settings()


def error_body(code: str, message: str, details: object = None) -> dict[str, object]:
    """
    The one error shape the frontend parses (frontend-imp.md §5). Every non-2xx
    response in this service goes through here.
    """
    return {"error": {"code": code, "message": message, "details": details}}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await create_tables()

    # The provider layer shares one httpx client for the process; building it
    # here means connections are pooled and closed cleanly on shutdown.
    from app.llm.registry import build_providers, close_providers

    app.state.providers = await build_providers(settings)
    if not settings.has_llm_credential:
        logger.warning(
            "ANTHROPIC_API_KEY is not set — the app will run, but POST /api/workflows/{id}/run "
            "will return 503 missing_api_key until it is."
        )
    try:
        yield
    finally:
        await close_providers(app.state.providers)


app = FastAPI(
    title="Workflow Studio API",
    version="1.0.0",
    description=(
        "Build a graph of agents, tools and routers; save it; run it; and read back "
        "every step as an ordered event log."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message, exc.details),
    )


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(
    _request: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's own body-validation failures, in our envelope rather than its."""
    return JSONResponse(
        status_code=422,
        content=error_body(
            "validation_error",
            "The request body does not match the expected shape.",
            exc.errors(),
        ),
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(_request: Request, exc: Exception) -> JSONResponse:
    """The traceback goes to the log; the client gets a generic message."""
    logger.exception("Unhandled error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content=error_body("internal_error", "Something went wrong on the server."),
    )


app.include_router(workflows_router.router)
app.include_router(registry_router.router)
app.include_router(runs_router.router)


@app.get("/api/health", tags=["meta"])
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "llm_configured": settings.has_llm_credential,
    }
