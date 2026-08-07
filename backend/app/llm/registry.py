import httpx

from app.config import Settings
from app.errors import MissingAPIKeyError, UnknownProviderError
from app.llm.anthropic import AnthropicProvider
from app.llm.base import LLMProvider

Providers = dict[str, LLMProvider]


async def build_providers(settings: Settings) -> Providers:
    """
    Built once in the FastAPI lifespan so the httpx client — and its connection
    pool — is shared for the life of the process and closed cleanly.

    Providers are constructed even without a credential: the app must boot so
    browsing and editing still works, and `/run` reports `missing_api_key`.
    """
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
    )
    return {
        "anthropic": AnthropicProvider(
            api_key=settings.anthropic_api_key,
            base_url=settings.anthropic_base_url,
            client=client,
        )
    }


async def close_providers(providers: Providers) -> None:
    for provider in providers.values():
        await provider.aclose()


def resolve_provider(providers: Providers, provider_id: str, settings: Settings) -> LLMProvider:
    """
    Maps `workflow.provider` to an instance, refusing early with the codes the
    frontend already renders.
    """
    if not settings.has_llm_credential:
        raise MissingAPIKeyError()
    provider = providers.get(provider_id)
    if provider is None:
        raise UnknownProviderError(
            f"“{provider_id}” is not a provider this server knows. Configured: "
            f"{', '.join(sorted(providers)) or 'none'}."
        )
    return provider
