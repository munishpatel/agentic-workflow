from typing import Any


class AppError(Exception):
    """
    Anything the API should report through the documented error envelope
    (frontend-imp.md §5):

        {"error": {"code": ..., "message": ..., "details": ...}}

    `code` is what the frontend branches on, so it is part of the contract —
    see the table in `app/main.py`. `message` is user-facing prose: write it as
    a sentence naming the fix.
    """

    status_code: int = 500
    code: str = "internal_error"

    def __init__(self, message: str, *, details: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ValidationFailedError(AppError):
    """A graph that `/validate` rejects. `details` carries the issue list."""

    status_code = 422
    code = "validation_error"


class MissingAPIKeyError(AppError):
    status_code = 503
    code = "missing_api_key"

    def __init__(self, message: str = "No LLM credential is configured.") -> None:
        super().__init__(message)


class UnknownProviderError(AppError):
    status_code = 400
    code = "unknown_provider"


class RunNotPausedError(AppError):
    """
    Resuming a run that is not waiting on anyone. 409 rather than 404 because
    the run exists — it is the *state* the request disagrees with, and a
    double-clicked Approve button must not read as a missing run.
    """

    status_code = 409
    code = "run_not_paused"


class MissingDecisionError(AppError):
    """
    A resume that does not rule on every held call. Rejected whole rather than
    defaulted, because silently approving nothing and silently approving
    everything are both worse than saying which call was left out.
    """

    status_code = 422
    code = "missing_decision"


# ── Errors raised inside a run ──────────────────────────────────────────────
# These do not become HTTP errors: the run has already started, so the partial
# timeline is worth more than a status code. The runner catches them, emits
# `run.error`, and returns 200 with a normal RunResponse (see main.py §Error
# mapping, and frontend-imp.md §5).


class RunError(AppError):
    """Base for failures that happen after `run.start` has been emitted."""

    status_code = 500
    code = "run_error"


class RefusalError(RunError):
    code = "refusal"

    def __init__(self, message: str = "The model declined to respond to this request.") -> None:
        super().__init__(message)


class IterationLimitError(RunError):
    code = "iteration_limit"


class NodeLimitError(RunError):
    code = "node_limit"


class StarvedOutputError(RunError):
    code = "starved_output"
