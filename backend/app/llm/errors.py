class LLMError(Exception):
    """Base for every provider failure, so FastAPI can map them in one place."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AuthError(LLMError):
    """401/403 — the credential is wrong, not missing. Retrying will not help."""


class RateLimitError(LLMError):
    """429. Retried with backoff honouring `retry-after` before it reaches here."""


class BadRequestError(LLMError):
    """
    400. Usually a parameter this model rejects — on `claude-opus-5` that means
    `temperature`, `top_p`, `top_k`, `budget_tokens`, an assistant-turn prefill,
    or disabled thinking above `high` effort. Never retried.
    """


class ProviderServerError(LLMError):
    """5xx from the provider. Retried, then surfaced."""


class NetworkError(LLMError):
    """Connection refused, DNS failure, timeout. Retried, then surfaced."""
