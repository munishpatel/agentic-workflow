import logging
from typing import ClassVar

from pydantic import BaseModel, EmailStr, Field

from app.models import SentEmail
from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register

logger = logging.getLogger("app.tools.send_email")


class SendEmailInput(BaseModel):
    to: EmailStr = Field(description="Recipient address.")
    subject: str = Field(min_length=1, description="Subject line.")
    body: str = Field(min_length=1, description="Message body, plain text.")


@register
class SendEmail:
    """
    Mocked on purpose: validates, records, and returns a confirmation. Nothing
    leaves the machine. `GET /api/emails` is the evidence it ran.
    """

    id: ClassVar[str] = "send_email"
    name: ClassVar[str] = "Send email"
    description: ClassVar[str] = (
        "Send an email to one recipient. Call this when the user asks for something to be "
        "sent, mailed, or shared with a named address. Mocked in this environment: the "
        "message is recorded in an outbox and nothing is actually delivered."
    )
    Input: ClassVar[type[BaseModel]] = SendEmailInput

    async def execute(self, args: SendEmailInput, ctx: ToolContext) -> ToolResult:
        if ctx.session is not None:
            ctx.session.add(
                SentEmail(
                    to=str(args.to),
                    subject=args.subject,
                    body=args.body,
                    run_id=ctx.run_id,
                )
            )
            await ctx.session.commit()
        logger.info("Mock email recorded for %s: %r", args.to, args.subject)
        return ToolResult(
            output=(
                f"Email recorded for {args.to} with subject “{args.subject}”. "
                "This environment mocks delivery — nothing was actually sent."
            )
        )
