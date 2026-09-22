"""Rehearse migration and rollback in one disposable profile without rewriting history."""

import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

from test_v2_reviewer import model_server  # noqa: F401


def test_profile_rollback_preserves_config_sessions_and_audit(launch_host, activate_host, model_server):
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    v1 = os.environ["OPENCODE_V1_1_18_32"]
    v2 = os.environ["OPENCODE_V2_2_0_3"]
    config_v1 = {"plugin": [[package, {"model": "fixture/reviewer"}]], "permission": {"bash": "ask"}}
    provider_v1 = {"provider": {"fixture": {
        "npm": "@ai-sdk/openai-compatible", "name": "Fixture",
        "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {name: {"name": name, "limit": {"context": 32000, "output": 1000}} for name in ["reviewer", "driver"]},
    }}}
    provider_v2 = {"providers": {"fixture": {
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {"reviewer": {"name": "Reviewer", "variants": [{"id": "max", "settings": {}}],
            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}, "limit": {"context": 32000, "output": 1000}}},
    }}}
    settings = {"model": "fixture/reviewer", "timeoutMs": 10000}

    def request(host, generation, path, body=None):
        query = "?" + urllib.parse.urlencode({"directory": str(host["project"])}) if generation == "v1" else ""
        req = urllib.request.Request(host["url"] + path + query,
            data=None if body is None else json.dumps(body).encode(), headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response)

    original = launch_host("v1", v1, config_v1, reviewer=settings, global_config=provider_v1, profile="rollback")
    activate_host(original, "v1")
    session = request(original, "v1", "/session", {"title": "Preserved rollback session"})
    project_config = original["project"] / "opencode.json"
    global_config = original["root"] / "config" / "opencode" / "opencode.json"
    backups = {path: path.read_bytes() for path in [project_config, global_config]}
    for path, content in backups.items():
        path.with_suffix(".json.rollback-backup").write_bytes(content)
    audit = original["root"] / "reviewer-audit.jsonl"
    historical = json.dumps({"schemaVersion": 2, "requestID": "fixture_history", "sessionID": "fixture_history", "permission": "bash", "outcome": "allow", "reason": "Preserved synthetic history", "timestamp": "2026-01-01T00:00:00.000Z", "durationMs": 1}) + "\n"
    audit.write_text(historical)
    original["stop"]()

    migrated = launch_host("v2", v2, {"plugins": [package]}, reviewer=settings, global_config=provider_v2, profile="rollback")
    activate_host(migrated, "v2")
    operation = request(migrated, "v2", "/api/session", {"title": "Migration check", "location": {"directory": str(migrated["project"])}, "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})["data"]
    result = request(migrated, "v2", f"/api/session/{operation['id']}/permission", {"action": "shell", "resources": ["printf *"], "metadata": {"command": "printf safe"}})
    assert result["data"]["effect"] == "allow"
    migrated["stop"]()

    for path, content in backups.items():
        path.write_bytes(content)
    restored = launch_host("v1", v1, None, reviewer=settings, profile="rollback")
    for path, content in backups.items():
        assert path.read_bytes() == content
        assert path.with_suffix(".json.rollback-backup").read_bytes() == content
    assert request(restored, "v1", f"/session/{session['id']}")["title"] == "Preserved rollback session"
    request(restored, "v1", f"/session/{session['id']}/message", {"model": {"providerID": "fixture", "modelID": "driver"}, "parts": [{"type": "text", "text": "Print the fixture marker with bash once"}]})
    messages = request(restored, "v1", f"/session/{session['id']}/message")
    assert any(part.get("state", {}).get("status") == "completed" and "COMPATIBILITY_EXECUTED" in part.get("state", {}).get("output", "") for message in messages for part in message.get("parts", []))
    assert audit.read_text().startswith(historical)
    records = [json.loads(line) for line in audit.read_text().splitlines()]
    assert {record.get("hostGeneration") for record in records} >= {"v1", "v2"}
