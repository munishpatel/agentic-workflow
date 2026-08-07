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

    async def execute(self, args: WebSearchInput, ctx: ToolContext) -> ToolResult:
        settings = ctx.settings or get_settings()
        api_key = getattr(settings, "search_api_key", "")

        if not api_key:
            # Clearly labelled, never passed off as real. The app has to run
            # for a reviewer with no third-party key.
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
        "[MOCK RESULTS — no SEARCH_API_KEY is configured, so these are placeholders "
        "and not real search results. Say so if you rely on them.]"
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
