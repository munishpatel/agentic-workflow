"""
Seed the two demo workflows, so the app is non-empty on first run.

Shapes and positions match what the frontend's MSW mocks seed, so flipping
`VITE_USE_MOCKS` to false is not a jarring change. Idempotent: a workflow with
the same name is left alone.

    uv run python -m app.seed
"""

import asyncio
import logging

from sqlmodel import select

from app.config import get_settings
from app.db import SessionLocal, create_tables
from app.models import Workflow

logger = logging.getLogger("app.seed")

# The seeded workflows use whatever LLM_MODEL is configured, so changing it in
# .env before seeding actually takes effect. Each workflow still stores its own
# model — this is only the starting value.
DEFAULT_MODEL = get_settings().llm_model

RESEARCH_ASSISTANT = {
    "name": "Research assistant",
    "description": "Triages a question, researches it on the web when it needs current facts.",
    "provider": "anthropic",
    "model": DEFAULT_MODEL,
    "system_prompt": (
        "You are a precise research assistant. Prefer primary sources, cite what you used, "
        "and say plainly when you are unsure."
    ),
    "nodes": [
        {
            "id": "n_in",
            "kind": "input",
            "label": "Start",
            "config": {},
            "position": {"x": 40, "y": 220},
        },
        {
            "id": "n_route",
            "kind": "router",
            "label": "Triage",
            "config": {
                "routes": [
                    {
                        "label": "needs_research",
                        "description": (
                            "The question depends on current facts, prices, news or sources "
                            "that change over time."
                        ),
                    },
                    {
                        "label": "answer_directly",
                        "description": (
                            "The question can be answered from general knowledge alone."
                        ),
                    },
                ]
            },
            "position": {"x": 300, "y": 220},
        },
        {
            "id": "n_research",
            "kind": "agent",
            "label": "Research",
            "config": {
                "instruction": (
                    "Search the web for the question, read the top results, and answer with "
                    "the sources you used."
                ),
                "tools": ["web_search"],
                # 8, not 4: a live run showed the model legitimately searching
                # five times to cross-check a release date. That is thorough
                # research, not a runaway loop, and the cap should not cut it off.
                "max_tool_iterations": 8,
            },
            "position": {"x": 600, "y": 80},
        },
        {
            "id": "n_direct",
            "kind": "agent",
            "label": "Answer directly",
            "config": {
                "instruction": "Answer the question from what you already know. Be brief.",
                "tools": [],
                "max_tool_iterations": 1,
            },
            "position": {"x": 600, "y": 380},
        },
        {
            "id": "n_out",
            "kind": "output",
            "label": "Reply",
            "config": {},
            "position": {"x": 900, "y": 220},
        },
    ],
    # Two edges converge on n_out.response — legal because the sources sit
    # behind different ports of the same router (see graph/ports.py).
    "edges": [
        {
            "id": "e_in_route",
            "source": {"node_id": "n_in", "port": "message"},
            "target": {"node_id": "n_route", "port": "input"},
        },
        {
            "id": "e_route_research",
            "source": {"node_id": "n_route", "port": "needs_research"},
            "target": {"node_id": "n_research", "port": "prompt"},
        },
        {
            "id": "e_route_direct",
            "source": {"node_id": "n_route", "port": "answer_directly"},
            "target": {"node_id": "n_direct", "port": "prompt"},
        },
        {
            "id": "e_research_out",
            "source": {"node_id": "n_research", "port": "text"},
            "target": {"node_id": "n_out", "port": "response"},
        },
        {
            "id": "e_direct_out",
            "source": {"node_id": "n_direct", "port": "text"},
            "target": {"node_id": "n_out", "port": "response"},
        },
    ],
}

MATH_HELPER = {
    "name": "Math helper",
    "description": "One agent with a calculator. The minimal useful graph.",
    "provider": "anthropic",
    "model": DEFAULT_MODEL,
    "system_prompt": "You are a careful maths tutor. Show the steps, then the answer.",
    "nodes": [
        {
            "id": "m_in",
            "kind": "input",
            "label": "Start",
            "config": {},
            "position": {"x": 60, "y": 180},
        },
        {
            "id": "m_agent",
            "kind": "agent",
            "label": "Calculate",
            "config": {
                "instruction": (
                    "Work through the problem step by step. Use the calculator for every "
                    "arithmetic step rather than doing it in your head."
                ),
                "tools": ["calculator"],
                "max_tool_iterations": 6,
            },
            "position": {"x": 380, "y": 180},
        },
        {
            "id": "m_out",
            "kind": "output",
            "label": "Reply",
            "config": {},
            "position": {"x": 720, "y": 180},
        },
    ],
    "edges": [
        {
            "id": "m_e1",
            "source": {"node_id": "m_in", "port": "message"},
            "target": {"node_id": "m_agent", "port": "prompt"},
        },
        {
            "id": "m_e2",
            "source": {"node_id": "m_agent", "port": "text"},
            "target": {"node_id": "m_out", "port": "response"},
        },
    ],
}

SEED_WORKFLOWS = [RESEARCH_ASSISTANT, MATH_HELPER]


async def seed() -> None:
    await create_tables()
    async with SessionLocal() as session:
        for payload in SEED_WORKFLOWS:
            existing = await session.exec(select(Workflow).where(Workflow.name == payload["name"]))
            if existing.first() is not None:
                logger.info("Skipping %r — already seeded.", payload["name"])
                continue
            session.add(Workflow(**payload))
            logger.info("Seeded %r.", payload["name"])
        await session.commit()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    asyncio.run(seed())


if __name__ == "__main__":
    main()
