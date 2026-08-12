import pytest
from httpx import ASGITransport, AsyncClient

from app.seed import MATH_HELPER, RESEARCH_ASSISTANT


@pytest.fixture
async def client(tmp_path, monkeypatch) -> AsyncClient:
    """
    A fresh app against a throwaway SQLite file. Rebuilding the modules per test
    session keeps the engine bound to this database rather than the developer's.
    """
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")

    import importlib

    from app import config

    config.get_settings.cache_clear()
    import app.db

    importlib.reload(app.db)
    import app.main

    importlib.reload(app.main)

    from app.db import create_tables

    await create_tables()

    transport = ASGITransport(app=app.main.app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            yield http
    finally:
        # The reloaded engine has its own aiosqlite worker thread. Left
        # undisposed it outlives this test's event loop and raises "Event loop
        # is closed" into whichever test happens to be running next.
        await app.db.engine.dispose()


def workflow_input(**overrides) -> dict:
    payload = {
        "name": RESEARCH_ASSISTANT["name"],
        "description": RESEARCH_ASSISTANT["description"],
        "provider": "anthropic",
        "model": "claude-opus-5",
        "system_prompt": RESEARCH_ASSISTANT["system_prompt"],
        "nodes": RESEARCH_ASSISTANT["nodes"],
        "edges": RESEARCH_ASSISTANT["edges"],
    }
    payload.update(overrides)
    return payload


class TestRegistryEndpoints:
    async def test_node_kinds_publishes_all_five(self, client: AsyncClient) -> None:
        response = await client.get("/api/node-kinds")
        assert response.status_code == 200
        kinds = response.json()
        assert [k["kind"] for k in kinds] == ["input", "agent", "tool", "router", "output"]

    async def test_router_declares_dynamic_outputs(self, client: AsyncClient) -> None:
        kinds = {k["kind"]: k for k in (await client.get("/api/node-kinds")).json()}
        assert kinds["router"]["outputs"] == "dynamic"
        # Every other kind must be static — a second dynamic kind would force a
        # frontend change (frontend-imp.md §2).
        for kind, spec in kinds.items():
            if kind != "router":
                assert isinstance(spec["outputs"], list)

    async def test_agent_tools_is_array_of_enum_string(self, client: AsyncClient) -> None:
        """That exact shape is what triggers the frontend's ToolPicker."""
        kinds = {k["kind"]: k for k in (await client.get("/api/node-kinds")).json()}
        tools = kinds["agent"]["config_schema"]["properties"]["tools"]
        assert tools["type"] == "array"
        assert tools["items"]["type"] == "string"
        assert isinstance(tools["items"]["enum"], list)

    async def test_providers_lists_the_configured_model_first(
        self, client: AsyncClient, monkeypatch
    ) -> None:
        """
        The builder creates a new workflow with `models[0]`, so this ordering is
        what makes LLM_MODEL actually take effect.
        """
        providers = (await client.get("/api/providers")).json()
        assert providers[0]["id"] == "anthropic"
        assert providers[0]["models"][0] == "claude-opus-5"  # the test default
        assert "claude-sonnet-5" in providers[0]["models"]

    async def test_an_unrecognised_configured_model_is_still_offered(
        self, client: AsyncClient, monkeypatch
    ) -> None:
        """Configuring a model this build has not heard of must not drop it."""
        from app import config

        monkeypatch.setenv("LLM_MODEL", "claude-future-9")
        config.get_settings.cache_clear()
        try:
            models = (await client.get("/api/providers")).json()[0]["models"]
            assert models[0] == "claude-future-9"
            assert "claude-opus-5" in models
        finally:
            config.get_settings.cache_clear()

    async def test_a_workflow_created_without_a_model_uses_the_configured_one(
        self, client: AsyncClient
    ) -> None:
        body = workflow_input()
        del body["model"]
        created = (await client.post("/api/workflows", json=body)).json()
        assert created["model"] == "claude-opus-5"  # LLM_MODEL in this fixture


class TestWorkflowCrud:
    async def test_create_returns_201_and_the_saved_workflow(self, client: AsyncClient) -> None:
        response = await client.post("/api/workflows", json=workflow_input())
        assert response.status_code == 201
        body = response.json()
        assert body["id"].startswith("wf_")
        assert body["name"] == RESEARCH_ASSISTANT["name"]

    async def test_client_generated_ids_and_positions_round_trip(self, client: AsyncClient) -> None:
        """Edges reference nodes by client ids — rewriting them breaks the graph."""
        created = (await client.post("/api/workflows", json=workflow_input())).json()
        fetched = (await client.get(f"/api/workflows/{created['id']}")).json()
        assert [n["id"] for n in fetched["nodes"]] == [n["id"] for n in RESEARCH_ASSISTANT["nodes"]]
        assert [e["id"] for e in fetched["edges"]] == [e["id"] for e in RESEARCH_ASSISTANT["edges"]]
        assert fetched["nodes"][0]["position"] == {"x": 40, "y": 220}

    async def test_blank_description_round_trips_as_null(self, client: AsyncClient) -> None:
        created = (
            await client.post("/api/workflows", json=workflow_input(description=None))
        ).json()
        assert created["description"] is None

    async def test_list_returns_summaries_with_deduplicated_tool_ids(
        self, client: AsyncClient
    ) -> None:
        await client.post("/api/workflows", json=workflow_input())
        await client.post(
            "/api/workflows",
            json=workflow_input(
                name=MATH_HELPER["name"],
                nodes=MATH_HELPER["nodes"],
                edges=MATH_HELPER["edges"],
            ),
        )
        summaries = (await client.get("/api/workflows")).json()
        assert len(summaries) == 2
        research = next(s for s in summaries if s["name"] == RESEARCH_ASSISTANT["name"])
        assert research["node_count"] == 5
        assert research["tool_ids"] == ["web_search"]
        # A summary is not a full workflow.
        assert "nodes" not in research

    async def test_update_preserves_created_at_and_moves_updated_at(
        self, client: AsyncClient
    ) -> None:
        created = (await client.post("/api/workflows", json=workflow_input())).json()
        updated = (
            await client.put(f"/api/workflows/{created['id']}", json=workflow_input(name="Renamed"))
        ).json()
        assert updated["name"] == "Renamed"
        assert updated["created_at"] == created["created_at"]
        assert updated["updated_at"] >= created["updated_at"]

    async def test_delete_returns_204_with_no_body(self, client: AsyncClient) -> None:
        created = (await client.post("/api/workflows", json=workflow_input())).json()
        response = await client.delete(f"/api/workflows/{created['id']}")
        assert response.status_code == 204
        assert response.content == b""
        assert (await client.get(f"/api/workflows/{created['id']}")).status_code == 404


class TestErrorEnvelope:
    async def test_missing_workflow_returns_the_documented_shape(self, client: AsyncClient) -> None:
        response = await client.get("/api/workflows/wf_nope")
        assert response.status_code == 404
        body = response.json()
        assert body["error"]["code"] == "not_found"
        assert isinstance(body["error"]["message"], str)

    async def test_malformed_body_uses_the_same_envelope(self, client: AsyncClient) -> None:
        response = await client.post("/api/workflows", json={"nope": True})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


class TestValidateEndpoint:
    async def test_the_seeded_branching_graph_validates_clean(self, client: AsyncClient) -> None:
        created = (await client.post("/api/workflows", json=workflow_input())).json()
        result = (
            await client.post(f"/api/workflows/{created['id']}/validate", json=workflow_input())
        ).json()
        assert result["valid"] is True
        assert result["errors"] == []

    async def test_validates_the_submitted_draft_not_the_stored_graph(
        self, client: AsyncClient
    ) -> None:
        created = (await client.post("/api/workflows", json=workflow_input())).json()
        broken = workflow_input(
            nodes=[n for n in RESEARCH_ASSISTANT["nodes"] if n["kind"] != "output"],
            edges=[e for e in RESEARCH_ASSISTANT["edges"] if e["target"]["node_id"] != "n_out"],
        )
        result = (await client.post(f"/api/workflows/{created['id']}/validate", json=broken)).json()
        assert result["valid"] is False
        assert "missing_output_node" in [issue["code"] for issue in result["errors"]]
