"""Local executable evidence from installed packages through fresh host reviews."""

import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request

import pytest
import hosts
from test_v2_reviewer import model_server  # noqa: F401

CASES = [(generation, version)
         for generation in ("v1", "v2")
         if os.environ.get("HOST_GENERATION", generation) == generation
         for version in hosts.anchors(generation)]


@pytest.mark.parametrize("generation,version", CASES)
def test_local_executable_evidence_reaches_the_reviewer(launch_host, activate_host, model_server, generation, version, tmp_path):
    binary = os.environ[f"OPENCODE_{generation.upper()}_{version.replace('.', '_')}"]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    model = {"name": "Fixture", "limit": {"context": 64000, "output": 1000}}
    if generation == "v1":
        probe = tmp_path / "permission-probe"
        probe.mkdir()
        command_file = tmp_path / "command.txt"
        (probe / "package.json").write_text(json.dumps({"name": "fixture-permission", "type": "module"}))
        (probe / "index.js").write_text('import { readFile } from "node:fs/promises"; export default { id: "fixture-permission", async server() { return { tool: { fixture_permission: { description: "Request a synthetic permission without executing the command", args: {}, async execute(_args, ctx) { const command = await readFile(' + json.dumps(str(command_file)) + ', "utf8"); await ctx.ask({ permission: "bash", patterns: [command], always: [], metadata: { command } }); return "COMPATIBILITY_EXECUTED"; } } } }; } };')
        config = {"plugin": [package, str(probe)], "permission": {"bash": "ask"}}
        provider = {"provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
            "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
            "models": {"reviewer": model, "driver": model}}}}
        model_server["control"]["tool"] = "fixture_permission"
    else:
        config = {"plugins": [package]}
        provider = {"providers": {"fixture": {"package": "@opencode/ai/providers/openai-compatible",
            "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
            "models": {"reviewer": {**model, "variants": [{"id": "medium", "settings": {}}],
                "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}}}}}}
    host = launch_host(generation, binary, config,
        reviewer={"model": "fixture/reviewer", "timeoutMs": 15000, "reviewBudgetMs": 30000}, global_config=provider)
    activate_host(host, generation)
    project = host["project"]
    (project / "--actual.js").write_text('console.log("ACTUAL_EXECUTED_SENTINEL")')
    (project / "argument.js").write_text('console.log("UNEXECUTED_ARGUMENT_SENTINEL")')
    for name in ("first", "second"):
        (project / name).mkdir()
        (project / name / "task.js").write_text(f'console.log("{name.upper()}_EXECUTED_SENTINEL")')
    for args in [["init"], ["config", "user.email", "fixture@example.invalid"],
                 ["config", "user.name", "Fixture"], ["commit", "--allow-empty", "-m", "fixture"],
                 ["remote", "add", "origin", "https://local.example.invalid/project.git"]]:
        subprocess.run(["git", *args], cwd=project, check=True, capture_output=True)

    def request(path, body):
        query = "?" + urllib.parse.urlencode({"directory": str(project)}) if generation == "v1" else ""
        req = urllib.request.Request(host["url"] + path + query, data=json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            value = json.load(response)
            return value.get("data", value)

    for command, included in [
        ("printf node ./argument.js", []),
        ("ssh fixture.invalid node ./argument.js", []),
        ("node --eval=0 ./argument.js", []),
        ("node --conditions ./argument.js ./--actual.js", ["ACTUAL_EXECUTED_SENTINEL"]),
        ("node -- --actual.js ./argument.js", ["ACTUAL_EXECUTED_SENTINEL"]),
        ("(cd first && node task.js) && (cd second && node task.js)", ["FIRST_EXECUTED_SENTINEL", "SECOND_EXECUTED_SENTINEL"]),
        ("ssh fixture.invalid git push origin", []),
        ("git push origin", ["https://local.example.invalid/project.git"]),
    ]:
        before = len(model_server["calls"])
        if generation == "v1":
            command_file.write_text(command)
            session = request("/session", {"title": "Local evidence fixture"})
            request(f"/session/{session['id']}/message", {"model": {"providerID": "fixture", "modelID": "driver"},
                "parts": [{"type": "text", "text": "Request the synthetic fixture permission without executing a command"}]})
        else:
            session = request("/api/session", {"title": "Local evidence fixture", "location": {"directory": str(project)},
                "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
            request(f"/api/session/{session['id']}/permission", {"action": "shell", "resources": [command], "metadata": {"command": command}})
        calls = [call for call in model_server["calls"][before:] if call.get("model") == "reviewer"]
        assert calls, command
        text = json.dumps(calls[-1]["messages"])
        for expected in included:
            assert expected in text, (command, text)
        for excluded in {"ACTUAL_EXECUTED_SENTINEL", "UNEXECUTED_ARGUMENT_SENTINEL", "FIRST_EXECUTED_SENTINEL", "SECOND_EXECUTED_SENTINEL", "https://local.example.invalid/project.git"} - set(included):
            assert excluded not in text, (command, text)
