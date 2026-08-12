"""
The frontend's conformance suite, ported.

`frontend/src/mocks/handlers.test.ts` ran these ten assertions against the mock
API *before this service existed*. They are an acceptance suite handed to us, and
the cheapest possible check that the two halves agree. The provider is stubbed,
so this runs in CI with no API key.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.seed import MATH_HELPER, RESEARCH_ASSISTANT
from tests.fakes import FakeProvider, refusal_response, route_response, text_response


@pytest.fixture
async def app_and_client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'conf.db'}")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")

    import importlib

    from app import config

    config.get_settings.cache_clear()
    import app.db

    importlib.reload(app.db)
    import app.main

    importlib.reload(app.main)

    from app.db import create_tables

    await create_tables()

    application = app.main.app
    application.state.providers = {}
    transport = ASGITransport(app=application)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            yield application, http
    finally:
        # Each test reloads `app.db` and gets a fresh engine. Without disposing
        # it, aiosqlite's worker thread outlives the test's event loop and
        # occasionally raises "Event loop is closed" into an unrelated test.
        await app.db.engine.dispose()


@pytest.fixture
async def client(app_and_client):
    _, http = app_and_client
    return http


def use_provider(application, provider: FakeProvider) -> None:
    application.state.providers = {"anthropic": provider}


def workflow_body(source: dict) -> dict:
    return {
        "name": source["name"],
        "description": source["description"],
        "provider": "anthropic",
        "model": "claude-opus-5",
        "system_prompt": source["system_prompt"],
        "nodes": source["nodes"],
        "edges": source["edges"],
    }


async def seed_workflow(client: AsyncClient, source: dict) -> str:
    response = await client.post("/api/workflows", json=workflow_body(source))
    return response.json()["id"]


class TestSchemaDiscovery:
    async def test_publishes_node_kinds_tools_and_providers(self, client: AsyncClient) -> None:
        kinds = (await client.get("/api/node-kinds")).json()
        assert [kind["kind"] for kind in kinds] == [
            "input",
            "agent",
            "tool",
            "router",
            "output",
        ]

        tools = (await client.get("/api/tools")).json()
        assert len(tools) == 4

        providers = (await client.get("/api/providers")).json()
        assert "claude-opus-5" in providers[0]["models"]


class TestRunEventLog:
    async def test_returns_an_ordered_event_log_and_stores_it_for_replay(
        self, app_and_client
    ) -> None:
        """
        The big one. Covers seq ordering and uniqueness, run.start/run.end
        bookending, route.decision, node.skipped, edge.transfer, and replay
        equality — the six things the UI's reducer depends on.
        """
        application, client = app_and_client
        workflow_id = await seed_workflow(client, RESEARCH_ASSISTANT)
        use_provider(
            application,
            FakeProvider(
                [route_response("needs_research"), text_response("Here is what I found.")]
            ),
        )

        response = await client.post(
            f"/api/workflows/{workflow_id}/run",
            json={"message": "What changed in agent tooling?", "history": []},
        )
        assert response.status_code == 200
        run = response.json()

        seqs = [event["seq"] for event in run["events"]]
        assert seqs == sorted(seqs), "events must be in seq order"
        assert len(set(seqs)) == len(seqs), "seq must be unique within a run"

        assert run["events"][0]["type"] == "run.start"
        assert run["events"][-1]["type"] == "run.end"

        types = {event["type"] for event in run["events"]}
        assert "route.decision" in types
        assert "node.skipped" in types, "the pruned branch must be visible"
        assert "edge.transfer" in types
        assert run["final_response"] != ""

        # Replay returns exactly what /run returned — that shared shape is what
        # lets the UI reduce both through one function.
        replayed = (await client.get(f"/api/runs/{run['run_id']}")).json()
        assert replayed["events"] == run["events"]
        assert replayed["final_response"] == run["final_response"]

        history = (await client.get(f"/api/workflows/{workflow_id}/runs")).json()
        assert len(history) == 1
        assert history[0]["run_id"] == run["run_id"]

    async def test_run_end_agrees_with_the_top_level_response(self, app_and_client) -> None:
        """The UI takes the message from one and the timeline from the other."""
        application, client = app_and_client
        workflow_id = await seed_workflow(client, MATH_HELPER)
        use_provider(application, FakeProvider([text_response("432.")]))

        run = (
            await client.post(
                f"/api/workflows/{workflow_id}/run", json={"message": "1200*1.08/3", "history": []}
            )
        ).json()
        run_end = run["events"][-1]
        assert run_end["payload"]["final_response"] == run["final_response"]
        assert run_end["payload"]["duration_ms"] == run["duration_ms"]
        assert run_end["payload"]["usage"] == run["usage"]

    async def test_a_failing_tool_is_recoverable_within_a_run(self, app_and_client) -> None:
        from tests.fakes import tool_call_response

        application, client = app_and_client
        workflow_id = await seed_workflow(client, MATH_HELPER)
        use_provider(
            application,
            FakeProvider(
                [
                    tool_call_response("calculator", {"expression": "1/0"}, call_id="t1"),
                    text_response("That divides by zero."),
                ]
            ),
        )
        run = (
            await client.post(
                f"/api/workflows/{workflow_id}/run", json={"message": "1/0", "history": []}
            )
        ).json()
        failed = [
            event
            for event in run["events"]
            if event["type"] == "tool.result" and event["payload"]["is_error"]
        ]
        assert failed, "the failing tool result must be visible in the timeline"
        assert run["final_response"] != "", "the agent recovers and still answers"

    async def test_a_refusal_returns_200_with_a_timeline_ending_in_run_error(
        self, app_and_client
    ) -> None:
        application, client = app_and_client
        workflow_id = await seed_workflow(client, MATH_HELPER)
        use_provider(application, FakeProvider([refusal_response()]))

        response = await client.post(
            f"/api/workflows/{workflow_id}/run", json={"message": "refuse this", "history": []}
        )
        # 200, not 500 — the partial timeline is worth more than a status code.
        assert response.status_code == 200
        run = response.json()
        assert run["events"][-1]["type"] == "run.error"
        assert run["events"][-1]["payload"]["code"] == "refusal"
        assert run["final_response"] == ""


class TestErrorEnvelope:
    async def test_every_non_2xx_uses_the_documented_shape(self, client: AsyncClient) -> None:
        response = await client.get("/api/workflows/wf_missing")
        assert response.status_code == 404
        body = response.json()
        assert set(body["error"]) >= {"code", "message"}
        assert body["error"]["code"] == "not_found"

    async def test_missing_credential_is_reported_before_the_run_starts(
        self, app_and_client, monkeypatch
    ) -> None:
        """
        A pre-run failure has no timeline worth returning, so it is an HTTP
        error with the code the frontend renders as "set ANTHROPIC_API_KEY".
        """
        _, client = app_and_client
        workflow_id = await seed_workflow(client, MATH_HELPER)

        from app import config

        config.get_settings.cache_clear()
        monkeypatch.setenv("ANTHROPIC_API_KEY", "")

        response = await client.post(
            f"/api/workflows/{workflow_id}/run", json={"message": "hi", "history": []}
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "missing_api_key"
        config.get_settings.cache_clear()

    async def test_running_a_workflow_that_does_not_exist(self, client: AsyncClient) -> None:
        response = await client.post(
            "/api/workflows/wf_ghost/run", json={"message": "hi", "history": []}
        )
        assert response.status_code == 404

    async def test_an_empty_message_is_rejected(self, client: AsyncClient) -> None:
        workflow_id = await seed_workflow(client, MATH_HELPER)
        response = await client.post(
            f"/api/workflows/{workflow_id}/run", json={"message": "", "history": []}
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"

    async def test_a_run_on_an_invalid_graph_is_refused_with_the_issues(
        self, app_and_client
    ) -> None:
        application, client = app_and_client
        broken = dict(MATH_HELPER)
        broken["nodes"] = [node for node in MATH_HELPER["nodes"] if node["kind"] != "output"]
        broken["edges"] = [
            edge for edge in MATH_HELPER["edges"] if edge["target"]["node_id"] != "m_out"
        ]
        workflow_id = await seed_workflow(client, broken)
        use_provider(application, FakeProvider([text_response("never reached")]))

        response = await client.post(
            f"/api/workflows/{workflow_id}/run", json={"message": "hi", "history": []}
        )
        assert response.status_code == 422
        body = response.json()
        assert body["error"]["code"] == "validation_error"
        assert any(issue["code"] == "missing_output_node" for issue in body["error"]["details"])


class TestOutbox:
    async def test_emails_is_global_and_newest_first(self, app_and_client) -> None:
        from tests.fakes import tool_call_response

        application, client = app_and_client
        workflow_id = await seed_workflow(client, MATH_HELPER)

        assert (await client.get("/api/emails")).json() == []

        use_provider(
            application,
            FakeProvider(
                [
                    tool_call_response(
                        "send_email",
                        {"to": "team@example.com", "subject": "Digest", "body": "Hello."},
                        call_id="t1",
                    ),
                    text_response("Sent."),
                ]
            ),
        )
        run = (
            await client.post(
                f"/api/workflows/{workflow_id}/run",
                json={"message": "email the team", "history": []},
            )
        ).json()

        # send_email is gated, so the run holds rather than sending.
        assert run["status"] == "paused"
        assert (await client.get("/api/emails")).json() == []

        resumed = await client.post(
            f"/api/runs/{run['run_id']}/resume",
            json={"decisions": [{"call_id": "t1", "approved": True}]},
        )
        assert resumed.status_code == 200, resumed.json()
        assert resumed.json()["status"] == "ok"

        emails = (await client.get("/api/emails")).json()
        assert len(emails) == 1
        assert emails[0]["to"] == "team@example.com"
        assert emails[0]["run_id"] is not None


class TestApprovalEndpoint:
    """
    The resume endpoint's job is to make "approve" mean exactly the call the
    reviewer was shown, and to make every other request bounce off.
    """

    async def _pause(self, application, client) -> tuple[str, dict]:
        from tests.fakes import tool_call_response

        workflow_id = await seed_workflow(client, MATH_HELPER)
        use_provider(
            application,
            FakeProvider(
                [
                    tool_call_response(
                        "send_email",
                        {"to": "team@example.com", "subject": "Hi", "body": "Hello."},
                        call_id="t1",
                    ),
                    text_response("Sent."),
                ]
            ),
        )
        run = (
            await client.post(
                f"/api/workflows/{workflow_id}/run",
                json={"message": "email the team", "history": []},
            )
        ).json()
        return workflow_id, run

    async def test_a_paused_run_is_a_200_with_its_held_calls(self, app_and_client) -> None:
        application, client = app_and_client
        _, run = await self._pause(application, client)

        assert run["status"] == "paused"
        assert run["final_response"] == ""
        held = run["pending_approvals"]
        assert len(held) == 1
        assert held[0]["tool"] == "send_email"
        assert held[0]["call_id"] == "t1"
        assert held[0]["input"]["to"] == "team@example.com"

    async def test_a_paused_run_replays_with_its_held_calls_intact(self, app_and_client) -> None:
        """Reopening the page must not lose an approval someone walked away from."""
        application, client = app_and_client
        _, run = await self._pause(application, client)

        replayed = (await client.get(f"/api/runs/{run['run_id']}")).json()
        assert replayed["status"] == "paused"
        assert [call["call_id"] for call in replayed["pending_approvals"]] == ["t1"]

    async def test_resuming_an_unknown_run_is_404(self, client) -> None:
        response = await client.post(
            "/api/runs/run_nope/resume",
            json={"decisions": [{"call_id": "t1", "approved": True}]},
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"

    async def test_resuming_a_finished_run_is_409(self, app_and_client) -> None:
        """A double-clicked Approve must not send twice."""
        application, client = app_and_client
        _, run = await self._pause(application, client)

        first = await client.post(
            f"/api/runs/{run['run_id']}/resume",
            json={"decisions": [{"call_id": "t1", "approved": True}]},
        )
        assert first.status_code == 200

        second = await client.post(
            f"/api/runs/{run['run_id']}/resume",
            json={"decisions": [{"call_id": "t1", "approved": True}]},
        )
        assert second.status_code == 409
        assert second.json()["error"]["code"] == "run_not_paused"
        # And crucially: still one email, not two.
        assert len((await client.get("/api/emails")).json()) == 1

    async def test_a_decision_for_a_call_this_run_is_not_holding_is_422(
        self, app_and_client
    ) -> None:
        application, client = app_and_client
        _, run = await self._pause(application, client)

        response = await client.post(
            f"/api/runs/{run['run_id']}/resume",
            json={"decisions": [{"call_id": "some_other_call", "approved": True}]},
        )
        assert response.status_code == 422
        body = response.json()
        assert body["error"]["code"] == "missing_decision"
        assert body["error"]["details"]["missing_call_ids"] == ["t1"]
        # Nothing ran, and the run is still waiting.
        assert (await client.get("/api/emails")).json() == []
        assert (await client.get(f"/api/runs/{run['run_id']}")).json()["status"] == "paused"

    async def test_rejecting_finishes_the_run_and_sends_nothing(self, app_and_client) -> None:
        application, client = app_and_client
        _, run = await self._pause(application, client)

        resumed = (
            await client.post(
                f"/api/runs/{run['run_id']}/resume",
                json={
                    "decisions": [{"call_id": "t1", "approved": False, "note": "Wrong recipient."}]
                },
            )
        ).json()

        assert resumed["status"] == "ok"
        assert resumed["pending_approvals"] == []
        assert (await client.get("/api/emails")).json() == []

    async def test_the_resumed_run_replaces_the_row_rather_than_adding_one(
        self, app_and_client
    ) -> None:
        """One run, one row, one timeline — history must not show it twice."""
        application, client = app_and_client
        workflow_id, run = await self._pause(application, client)

        await client.post(
            f"/api/runs/{run['run_id']}/resume",
            json={"decisions": [{"call_id": "t1", "approved": True}]},
        )

        runs = (await client.get(f"/api/workflows/{workflow_id}/runs")).json()
        matching = [row for row in runs if row["run_id"] == run["run_id"]]
        assert len(matching) == 1
        assert matching[0]["status"] == "ok"
        assert matching[0]["final_response"] == "Sent."


class TestHistoryIsPassedThrough:
    async def test_prior_turns_reach_the_model(self, app_and_client) -> None:
        application, client = app_and_client
        workflow_id = await seed_workflow(client, MATH_HELPER)
        provider = FakeProvider([text_response("Still 432.")])
        use_provider(application, provider)

        await client.post(
            f"/api/workflows/{workflow_id}/run",
            json={
                "message": "and again?",
                "history": [
                    {"role": "user", "content": "1200*1.08/3"},
                    {"role": "assistant", "content": "432"},
                ],
            },
        )
        messages = provider.requests[0].messages
        assert [message.role for message in messages] == ["user", "assistant", "user"]
        assert messages[0].content[0].text == "1200*1.08/3"
