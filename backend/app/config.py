from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Runtime configuration, read from the environment and `.env`.

    Deliberately tolerant of a missing `ANTHROPIC_API_KEY`: the app must boot
    without one so browsing and editing workflows still works, and `/run`
    returns `503 missing_api_key` — which the frontend already renders as
    "set ANTHROPIC_API_KEY in backend/.env". Failing at import time would hand
    a reviewer a stack trace instead of a working UI with a clear message.
    """

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    anthropic_api_key: str = ""
    anthropic_base_url: str = "https://api.anthropic.com"
    llm_provider: str = "anthropic"
    llm_model: str = "claude-opus-5"

    database_url: str = "sqlite+aiosqlite:///./workflows.db"

    # Comma-separated. Unnecessary behind the Vite dev proxy; required for any
    # deployment where the two halves are served from different origins.
    cors_origins: str = "http://localhost:5173"

    # Optional — web_search returns clearly-labelled mock results when unset.
    search_api_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def has_llm_credential(self) -> bool:
        return bool(self.anthropic_api_key.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
