from datetime import UTC, datetime
from typing import ClassVar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register


class DateTimeInput(BaseModel):
    timezone: str = Field(
        default="UTC",
        description="IANA timezone name, e.g. Europe/London or America/New_York.",
    )


@register
class CurrentDateTime:
    """Trivial, but it proves the registry generalises and grounds the other tools."""

    id: ClassVar[str] = "current_datetime"
    name: ClassVar[str] = "Current date and time"
    description: ClassVar[str] = (
        "Get the current date and time in a given timezone. Call this before answering "
        "anything time-relative — “today”, “this week”, “how long until…” — because your "
        "training data has no idea what today's date is."
    )
    Input: ClassVar[type[BaseModel]] = DateTimeInput

    async def execute(self, args: DateTimeInput, ctx: ToolContext) -> ToolResult:
        try:
            zone = ZoneInfo(args.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            return ToolResult(
                output=(
                    f"“{args.timezone}” is not a known IANA timezone. "
                    "Try one like Europe/London or America/New_York."
                ),
                is_error=True,
            )
        now = datetime.now(UTC).astimezone(zone)
        return ToolResult(output=now.strftime("%A, %d %B %Y at %H:%M:%S %Z (%z)"))
