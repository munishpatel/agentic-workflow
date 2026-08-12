import ast
import operator
from typing import ClassVar

from pydantic import BaseModel, Field

from app.tools.base import ToolContext, ToolResult
from app.tools.registry import register

# An AST whitelist, not `eval`. Small enough to read in full, which is the
# point: `eval` on model-supplied text is arbitrary code execution, and no
# amount of input filtering makes it safe.

_BINARY_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}

_UNARY_OPS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

# `2 ** 10` is fine; `2 ** 10_000_000` hangs the event loop, so exponents are
# bounded rather than left to the CPU.
MAX_EXPONENT = 1000


class CalculatorError(ValueError):
    """Raised for anything the whitelist refuses, with a message the model can act on."""


def evaluate(expression: str) -> float | int:
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise CalculatorError(f"That is not a valid arithmetic expression: {exc.msg}") from exc
    return _eval_node(tree.body)


def _eval_node(node: ast.AST) -> float | int:
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, int | float):
            raise CalculatorError("Only numbers are allowed.")
        return node.value

    if isinstance(node, ast.BinOp):
        op = _BINARY_OPS.get(type(node.op))
        if op is None:
            raise CalculatorError(f"The operator {type(node.op).__name__} is not allowed.")
        left, right = _eval_node(node.left), _eval_node(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > MAX_EXPONENT:
            raise CalculatorError(f"Exponents above {MAX_EXPONENT} are not allowed.")
        try:
            return op(left, right)
        except ZeroDivisionError as exc:
            raise CalculatorError("Division by zero.") from exc

    if isinstance(node, ast.UnaryOp):
        op = _UNARY_OPS.get(type(node.op))
        if op is None:
            raise CalculatorError(f"The operator {type(node.op).__name__} is not allowed.")
        return op(_eval_node(node.operand))

    # Everything else — names, attribute access, calls, comprehensions,
    # subscripts, lambdas, f-strings — is refused by falling through to here.
    raise CalculatorError(
        f"{type(node).__name__} is not allowed. Use numbers and + - * / // % ** only."
    )


class CalculatorInput(BaseModel):
    expression: str = Field(
        description="Arithmetic only, e.g. (1200 * 1.08) / 3. No variables or function calls.",
    )


@register
class Calculator:
    id: ClassVar[str] = "calculator"
    name: ClassVar[str] = "Calculator"
    description: ClassVar[str] = (
        "Evaluate an arithmetic expression and return the exact result. Call this whenever "
        "the answer depends on a specific number — totals, percentages, unit conversions, "
        "any multi-step arithmetic — rather than calculating in your head."
    )
    Input: ClassVar[type[BaseModel]] = CalculatorInput
    requires_approval: ClassVar[bool] = False

    async def execute(self, args: CalculatorInput, ctx: ToolContext) -> ToolResult:
        try:
            result = evaluate(args.expression)
        except CalculatorError as exc:
            # An error result, not an exception: the model gets to self-correct.
            return ToolResult(output=str(exc), is_error=True)
        if isinstance(result, float) and result.is_integer():
            return ToolResult(output=str(int(result)))
        return ToolResult(output=str(result))
