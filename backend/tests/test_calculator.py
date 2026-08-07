"""
The rejection half of these tests is worth more than the feature: `eval` on
model-supplied text is arbitrary code execution, so what the whitelist refuses
matters more than what it computes.
"""

import pytest

from app.tools.base import ToolContext
from app.tools.calculator import Calculator, CalculatorError, CalculatorInput, evaluate


class TestArithmetic:
    @pytest.mark.parametrize(
        ("expression", "expected"),
        [
            ("2 + 2", 4),
            ("1200 * 1.08", 1296.0),
            ("(1200 * 1.08) / 3", 432.0),
            ("10 - 3 - 2", 5),
            ("7 // 2", 3),
            ("7 % 3", 1),
            ("2 ** 10", 1024),
            ("-5 + 3", -2),
            ("+7", 7),
            ("2 + 3 * 4", 14),
            ("(2 + 3) * 4", 20),
            ("1.5 * 2", 3.0),
        ],
    )
    def test_evaluates_correctly(self, expression: str, expected: float) -> None:
        assert evaluate(expression) == expected


class TestRejections:
    """Each of these would be arbitrary code execution under `eval`."""

    @pytest.mark.parametrize(
        "expression",
        [
            '__import__("os").system("ls")',
            "__import__('os')",
            "().__class__.__bases__[0]",
            "(1).__class__",
            "open('/etc/passwd').read()",
            "exec('x=1')",
            "eval('1+1')",
            "print(1)",
            "abs(-1)",
            "x + 1",
            "x",
            "[i for i in range(10)]",
            "{'a': 1}",
            "[1, 2, 3]",
            "lambda: 1",
            "f'{1+1}'",
            "'a' * 3",
            "'string'",
            "True",
            "None",
            "1 if True else 2",
            "1 < 2",
            "not True",
            "a.b",
            "globals()",
        ],
    )
    def test_refuses_anything_outside_the_whitelist(self, expression: str) -> None:
        with pytest.raises(CalculatorError):
            evaluate(expression)

    def test_refuses_a_syntax_error_with_a_usable_message(self) -> None:
        with pytest.raises(CalculatorError) as excinfo:
            evaluate("2 +")
        assert "not a valid arithmetic expression" in str(excinfo.value)

    def test_refuses_an_enormous_exponent_rather_than_hanging(self) -> None:
        with pytest.raises(CalculatorError) as excinfo:
            evaluate("2 ** 10000000")
        assert "Exponents" in str(excinfo.value)

    def test_division_by_zero_is_a_message_not_a_crash(self) -> None:
        with pytest.raises(CalculatorError) as excinfo:
            evaluate("1 / 0")
        assert "Division by zero" in str(excinfo.value)


class TestToolInterface:
    async def test_returns_a_plain_string_result(self) -> None:
        result = await Calculator().execute(
            CalculatorInput(expression="(1200 * 1.08) / 3"), ToolContext()
        )
        assert result.is_error is False
        # Whole-valued floats are reported as integers — "432", not "432.0".
        assert result.output == "432"

    async def test_a_refused_expression_becomes_an_error_result_not_an_exception(self) -> None:
        result = await Calculator().execute(
            CalculatorInput(expression='__import__("os")'), ToolContext()
        )
        assert result.is_error is True
        assert "not allowed" in result.output

    async def test_division_by_zero_returns_an_error_result(self) -> None:
        result = await Calculator().execute(CalculatorInput(expression="1 / 0"), ToolContext())
        assert result.is_error is True
