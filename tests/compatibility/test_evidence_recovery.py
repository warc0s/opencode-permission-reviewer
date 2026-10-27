"""Literal intent recovery and compact evidence on fresh legacy and native hosts."""

import copy
import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request
import uuid

import pytest
import hosts
from test_v2_reviewer import model_server  # noqa: F401


CASES = [(generation, version)
         for generation in ("v1", "v2")
         if os.environ.get("HOST_GENERATION", generation) == generation
         for version in hosts.anchors(generation)]


@pytest.mark.parametrize("generation,version", CASES)
def test_literal_intent_survives_long_history_and_restart(launch_host, activate_host, model_server, generation, version):
    source = str(Path(__file__).resolve().parents[2])
    package = os.environ.get("PLUGIN_PACKAGE_PATH", source)
    binary = os.environ[f"OPENCODE_{generation.upper()}_{version.replace('.', '_')}"]
    model = {"name": "Fixture", "limit": {"context": 64000, "output": 1000}}
    if generation == "v1":
        config = {"plugin": [package], "permission": {"bash": "ask"}}
        provider = {"provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
            "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"}, "models": {"reviewer": model}}}}
    else:
        config = {"plugins": [package]}
        provider = {"providers": {"fixture": {"package": "@opencode/ai/providers/openai-compatible",
            "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
            "models": {"reviewer": {**model, "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}}}}}}
    reviewer = {"model": "fixture/reviewer", "timeoutMs": 10000, "reviewBudgetMs": 30000}
    host = launch_host(generation, binary, config, reviewer=reviewer, global_config=provider, profile="intent-fixture")
    activate_host(host, generation)
    (host["project"] / "package.json").write_text(json.dumps({"scripts": {"check": "bun run lint && bun run verify", "lint": "printf lint", "verify": "printf verify"}}))

    def request(path, body=None):
        query = "?" + urllib.parse.urlencode({"directory": str(host["project"])}) if generation == "v1" else ""
        req = urllib.request.Request(host["url"] + path + query,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            if response.status == 204:
                return None
            result = json.load(response)
            return result.get("data", result) if isinstance(result, dict) else result

    goal = "SYNTHETIC_USER_GOAL: fix the local bug and run the project check script."
    restriction = "SYNTHETIC_USER_RESTRICTION: do not push or delete any files."
    if generation == "v1":
        session = request("/session", {"title": "Literal intent fixture"})
        session_id = session["id"]
        def message(text, synthetic=False):
            return request(f"/session/{session_id}/message", {"noReply": True, "model": {"providerID": "fixture", "modelID": "reviewer"},
                "parts": [{"type": "text", "text": text, **({"synthetic": True} if synthetic else {})}]})
        message(goal)
        for index in range(225):
            message(f"SYNTHETIC_OPERATIONAL_STEP {index}", True)
        message(restriction)
    else:
        session = request("/api/session", {"title": "Literal intent fixture", "location": {"directory": str(host["project"])}, "model": {"providerID": "fixture", "id": "reviewer"}})
        session_id = session["id"]
        request(f"/api/session/{session_id}/prompt", {"text": goal})
        wait_prefix = "/api/session" if version == "2.0.3" else "/api/experimental/session"
        request(f"{wait_prefix}/{session_id}/wait", {})
        transfer = request(f"{wait_prefix}/{session_id}/export")
        template = next(message for message in transfer["messages"] if message["type"] == "assistant")
        for index in range(225):
            message = copy.deepcopy(template)
            message["id"] = "msg_" + uuid.uuid4().hex
            message["content"] = [{"type": "text", "text": f"SYNTHETIC_OPERATIONAL_STEP {index}"}]
            transfer["messages"].append(message)
        user = copy.deepcopy(next(message for message in transfer["messages"] if message["type"] == "user"))
        user["id"] = "msg_" + uuid.uuid4().hex
        user["text"] = restriction
        user["time"]["created"] += 1
        transfer["messages"].append(user)
        transfer["info"]["id"] = "ses_" + uuid.uuid4().hex
        for message in transfer["messages"]:
            message["id"] = "msg_" + uuid.uuid4().hex
        imported = request(f"{wait_prefix}/import", transfer)
        session_id = imported["id"]

    if generation == "v1":
        request(f"/session/{session_id}/summarize", {"providerID": "fixture", "modelID": "reviewer"})
    else:
        request(f"/api/session/{session_id}/compact", {})
        request(f"{wait_prefix}/{session_id}/wait", {})

    host["stop"]()
    host = launch_host(generation, binary, config, reviewer=reviewer, global_config=provider, profile="intent-fixture")
    activate_host(host, generation)
    proc = subprocess.run(["bun", "tests/compatibility/capture-evidence.ts", generation, host["url"], str(host["project"]), session_id, "bun run check"],
        cwd=source, env={**os.environ, "OPENCODE_PASSWORD": "synthetic-local-host-password"} if generation == "v2" else os.environ,
        capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["text"].count(goal) == 1, result
    assert result["text"].count(restriction) == 1, result
    assert "SYNTHETIC_OPERATIONAL_STEP" not in json.dumps(result["intent"]), result
    assert "PACKAGE_SCRIPT_ANALYSIS" in result["text"], result
    assert "printf lint" in result["text"], result
    assert result["characters"] <= result["budget"], result
    assert result["actionEvidenceComplete"] is True
