"""OpenCode V1 process harness, independent of the product V2 protocol."""

import os
import json
from pathlib import Path
import urllib.request
import urllib.parse

from test_v2_reviewer import model_server  # noqa: F401, shared synthetic HTTP provider

import pytest


@pytest.mark.parametrize("version", ["1.18.29", "1.18.30"])
def test_v1_isolated_server(launch_host, activate_host, probe_package, version):
    key = "OPENCODE_V1_" + version.replace(".", "_")
    binary = os.environ.get(key)
    if not binary:
        pytest.fail(f"Set {key} to the pinned OpenCode binary")
    host = launch_host("v1", binary, {"plugin": [probe_package]})
    activate_host(host, "v1")
    assert (host["project"] / "host-probe.txt").read_text() == "server:v1\n"


@pytest.mark.parametrize("version", ["1.18.29", "1.18.30"])
@pytest.mark.parametrize("outcome", ["allow", "deny", "brake"])
def test_v1_reviewer_applies_decision(launch_host, version, model_server, outcome, tmp_path):
    model_server["decision"]["outcome"] = "allow" if outcome == "brake" else outcome
    binary = os.environ["OPENCODE_V1_" + version.replace(".", "_")]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    provider = {"provider": {"fixture": {
        "npm": "@ai-sdk/openai-compatible", "name": "Fixture",
        "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {name: {"name": name, "limit": {"context": 32000, "output": 1000}}
                   for name in ["reviewer", "driver"]},
    }}}
    plugins = [[package, {"model": "fixture/reviewer"}]]
    if outcome == "brake":
        # A metadata-only tool makes this test safe even if review incorrectly allows it.
        probe = tmp_path / "brake-probe"
        probe.mkdir()
        (probe / "package.json").write_text(json.dumps({"name": "fixture-brake", "type": "module"}))
        (probe / "index.js").write_text('export default { id: "fixture-brake", async server() { return { tool: { fixture_permission: { description: "Request a synthetic permission without executing a command", args: {}, async execute(_args, ctx) { await ctx.ask({ permission: "bash", patterns: ["rm -rf /"], always: [], metadata: { command: "rm -rf /" } }); return "COMPATIBILITY_EXECUTED"; } } } }; } };')
        plugins.append(str(probe))
        model_server["control"]["tool"] = "fixture_permission"
    host = launch_host("v1", binary, {"plugin": plugins,
        "permission": {"bash": "ask"}}, reviewer={"model": "fixture/reviewer", "timeoutMs": 10000}, global_config=provider)
    query = "?" + urllib.parse.urlencode({"directory": str(host["project"])})

    def request(path, body=None):
        req = urllib.request.Request(host["url"] + path + query,
            data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response)

    session = request("/session", {"title": "Compatibility safe operation"})
    result = request(f"/session/{session['id']}/message", {
        "model": {"providerID": "fixture", "modelID": "driver"},
        "parts": [{"type": "text", "text": "Run printf COMPATIBILITY_EXECUTED using bash exactly once"}],
    })
    messages = request(f"/session/{session['id']}/message")
    executed = any(part.get("type") == "tool" and part.get("state", {}).get("status") == "completed"
                   and "COMPATIBILITY_EXECUTED" in part.get("state", {}).get("output", "")
                   for message in messages for part in message.get("parts", []))
    assert executed == (outcome == "allow"), result
    records = [json.loads(line) for line in (host["root"] / "reviewer-audit.jsonl").read_text().splitlines()]
    assert records[-1]["outcome"] == ("deny" if outcome == "brake" else outcome)
    assert records[-1]["decisionSource"] == ("emergency-brake" if outcome == "brake" else "llm-reviewer")
    if outcome == "brake":
        assert not any(call.get("model") == "reviewer" for call in model_server["calls"])
    assert records[-1]["schemaVersion"] == 3
    assert records[-1]["hostVersion"] == version
    assert records[-1]["application"] == "reply-accepted"
    assert records[-1]["reviewID"] != records[-1]["hostRequestID"]
    if outcome == "allow":
        tool = next(part for message in messages for part in message.get("parts", []) if part.get("type") == "tool")
        contract = {"permission": records[-1]["permission"], "contextRoles": sorted({message["info"]["role"] for message in messages}),
            "tool": {"name": tool["tool"], "callID": tool["callID"], "input": tool["state"]["input"], "status": tool["state"]["status"]}}
        (host["root"] / "native-contracts.json").write_text(json.dumps(contract, indent=2))
        assert contract == json.loads((Path(__file__).parent / "fixtures" / "v1-native.json").read_text())
