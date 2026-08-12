import json
import logging
from typing import Any, ClassVar

import httpx
from pydantic import BaseModel, Field

from app.config import get_settings
from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register

logger = logging.getLogger("app.tools.web_search")

TAVILY_URL = "https://api.tavily.com/search"


class WebSearchInput(BaseModel):
    query: str = Field(min_length=1, description="What to search for.")
    max_results: int = Field(default=3, ge=1, le=10, description="How many results to return.")


@register
class WebSearch:
    id: ClassVar[str] = "web_search"
    name: ClassVar[str] = "Web search"
    description: ClassVar[str] = (
        "Search the web and return the top results as title, url and snippet. Call this "
        "whenever the answer depends on information that changes — current events, prices, "
        "release versions, who currently holds a role — or when the user asks for sources. "
        "Do not call it for stable general knowledge."
    )
    Input: ClassVar[type[BaseModel]] = WebSearchInput
    requires_approval: ClassVar[bool] = False
    # Tavily answers in ~2s, but the Anthropic fallback runs several searches
    # plus dynamic filtering inside one call and needs longer than the default.
    timeout_seconds: ClassVar[int] = 90

    async def execute(self, args: WebSearchInput, ctx: ToolContext) -> ToolResult:
        settings = ctx.settings or get_settings()
        api_key = getattr(settings, "search_api_key", "")

        if not api_key:
            # Fall back to Anthropic's server-side search, which needs no
            # third-party account. Only if there is no LLM credential either do
            # we return placeholders — the app has to run with no keys at all.
            if getattr(settings, "anthropic_api_key", "").strip():
                return await _anthropic_search(args, settings)
            return ToolResult(output=_mock_results(args))

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                response = await client.post(
                    TAVILY_URL,
                    json={
                        "api_key": api_key,
                        "query": args.query,
                        "max_results": args.max_results,
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPError as exc:
            logger.warning("Search provider failed: %s", exc)
            return ToolResult(
                output=f"The search provider could not be reached: {exc}", is_error=True
            )

        return ToolResult(output=_format_results(payload, args.max_results))


# Anthropic's server-side web search. Claude runs the query on its own
# infrastructure, so this needs no third-party key — but it is a *server* tool,
# executed inside Anthropic's turn rather than by our dispatcher. Calling it
# from inside this tool, as its own one-shot request, is deliberate: the agent
# loop still sees one ordinary tool call and the run timeline still shows a
# `tool.call`/`tool.result` pair. Wiring the server tool into the main loop
# instead would make searches invisible to the timeline.
#
# The cost is one extra LLM round trip per search, plus Anthropic's per-search
# charge. Tavily stays the default when configured: it is provider-neutral and
# cheaper.

# Pinned, and deliberately independent of LLM_MODEL. This request is a lookup,
# not the agent thinking: the workflow's own model still writes the answer from
# whatever comes back here. Pinning buys three things — a predictable per-search
# cost whatever the workflow runs on, one known-good server-tool version instead
# of a model-to-version matrix, and no 400 when the configured model turns out
# not to support web search at all.
SEARCH_MODEL = "claude-sonnet-5"

# Only on Sonnet 5 / Opus 5-class models. Older ones need `web_search_20250305`,
# which is why SEARCH_MODEL is not allowed to drift.
SEARCH_TOOL_VERSION = "web_search_20260209"

SEARCH_INSTRUCTION = (
    "Search the web for: {query}\n\n"
    "Return the top {max_results} results and nothing else — no preamble, no closing "
    "commentary. Format each as exactly three lines:\n"
    "<n>. <title>\n   <url>\n   <one-sentence snippet>"
)


async def _anthropic_search(args: WebSearchInput, settings: Any) -> ToolResult:
    base_url = getattr(settings, "anthropic_base_url", "https://api.anthropic.com").rstrip("/")

    body = {
        "model": SEARCH_MODEL,
        "max_tokens": 4096,
        "tools": [{"type": SEARCH_TOOL_VERSION, "name": "web_search"}],
        "messages": [
            {
                "role": "user",
                "content": SEARCH_INSTRUCTION.format(
                    query=args.query, max_results=args.max_results
                ),
            }
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            response = await client.post(
                f"{base_url}/v1/messages",
                headers={
                    "x-api-key": settings.anthropic_api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=body,
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPError as exc:
        logger.warning("Anthropic web search failed: %s", exc)
        return ToolResult(output=f"The search provider could not be reached: {exc}", is_error=True)

    # A refusal is a 200 whose content may be empty, so check before reading it.
    if payload.get("stop_reason") == "refusal":
        return ToolResult(output="The search request was declined by the provider.", is_error=True)

    # Text blocks only — `server_tool_use` and `web_search_tool_result` blocks
    # are Claude's own working, already summarised into the text.
    text = "\n".join(
        block.get("text", "")
        for block in payload.get("content") or []
        if block.get("type") == "text"
    ).strip()

    if not text:
        return ToolResult(output="No results found.")
    return ToolResult(output=text)


def _format_results(payload: dict[str, Any], limit: int) -> str:
    results = (payload.get("results") or [])[:limit]
    if not results:
        return "No results found."
    lines = []
    for index, result in enumerate(results, start=1):
        title = result.get("title", "(untitled)")
        url = result.get("url", "")
        snippet = (result.get("content") or "").strip().replace("\n", " ")
        lines.append(f"{index}. {title}\n   {url}\n   {snippet}")
    return "\n".join(lines)


def _mock_results(args: WebSearchInput) -> str:
    header = (
        "[MOCK RESULTS — neither SEARCH_API_KEY nor ANTHROPIC_API_KEY is configured, so "
        "these are placeholders and not real search results. Say so if you rely on them.]"
    )
    body = [
        {
            "title": f"Overview: {args.query}",
            "url": "https://example.com/overview",
            "snippet": (
                "A placeholder result. Set SEARCH_API_KEY in backend/.env to search the "
                "real web via Tavily."
            ),
        },
        {
            "title": f"Background reading on {args.query}",
            "url": "https://example.com/background",
            "snippet": ("A second placeholder result, so result-shape handling is exercised."),
        },
        {
            "title": f"Further sources for {args.query}",
            "url": "https://example.com/sources",
            "snippet": "A third placeholder result.",
        },
    ][: args.max_results]
    return header + "\n" + json.dumps(body, indent=2)
