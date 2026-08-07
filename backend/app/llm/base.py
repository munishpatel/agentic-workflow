from typing import Annotated, Any, Literal, Protocol

from pydantic import BaseModel, Field

# Our own vocabulary for talking to a model — deliberately *not* shaped like any
# vendor's payload. Everything above this layer (the agent loop, the router, the
# scheduler) speaks only these types, so `engine/` never learns what Anthropic's
# wire format looks like and a second provider is one class, not a refactor.


class TextContent(BaseModel):
    kind: Literal["text"] = "text"
    text: str


class ToolCallContent(BaseModel):
    kind: Literal["tool_call"] = "tool_call"
    id: str
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)


class ToolResultContent(BaseModel):
    kind: Literal["tool_result"] = "tool_result"
    call_id: str
    output: str
    is_error: bool = False


LLMContent = Annotated[
    TextContent | ToolCallContent | ToolResultContent,
    Field(discriminator="kind"),
]


class LLMMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: list[LLMContent]


class ToolSchema(BaseModel):
    """A tool as the model sees it. Comes from `Tool.Input.model_json_schema()`."""

    name: str
    description: str
    input_schema: dict[str, Any]


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
        )


StopReason = Literal["end", "tool_call", "max_tokens", "refusal"]


class LLMRequest(BaseModel):
    model: str
    system: str = ""
    messages: list[LLMMessage] = Field(default_factory=list)
    tools: list[ToolSchema] = Field(default_factory=list)
    # Structured output — used by router nodes so a decision is a parsed field,
    # not JSON scraped out of prose.
    response_format: dict[str, Any] | None = None
    # Thinking is on by default on claude-opus-5 and shares this budget, so a
    # tight ceiling truncates the answer mid-thought. 16000 also keeps a
    # non-streaming request inside normal HTTP timeouts.
    max_tokens: int = 16000
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = "medium"


class LLMResponse(BaseModel):
    content: list[LLMContent] = Field(default_factory=list)
    stop_reason: StopReason = "end"
    usage: Usage = Field(default_factory=Usage)
    # Populated only on a refusal; the API leaves it null otherwise.
    refusal_category: str | None = None

    @property
    def text(self) -> str:
        """Every text block joined — what the agent loop returns to the graph."""
        return "\n".join(block.text for block in self.content if isinstance(block, TextContent))

    @property
    def tool_calls(self) -> list[ToolCallContent]:
        return [block for block in self.content if isinstance(block, ToolCallContent)]


class LLMProvider(Protocol):
    """
    Adding OpenAI later is one class satisfying this — which is the whole
    "multiple LLM providers" story reduced to a contained addition.
    """

    id: str

    async def send(self, request: LLMRequest) -> LLMResponse: ...

    async def aclose(self) -> None: ...
