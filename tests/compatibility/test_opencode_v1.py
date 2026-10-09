"""OpenCode V1 process harness, independent of the product V2 protocol."""

import os
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request
import urllib.parse

from test_v2_reviewer import model_server  # noqa: F401, shared synthetic HTTP provider

import pytest

V1_VERSIONS = (
    [os.environ["V1_HOST_VERSION"]]
    if os.environ.get("V1_HOST_VERSION")
    else ["1.18.29", "1.18.30", "1.18.31", "1.18.32"]
)

@pytest.mark.parametrize("version", V1_VERSIONS)
def test_v1_isolated_server(launch_host, activate_host, probe_package, version):
    key = "OPENCODE_V1_" + version.replace(".", "_")
    binary = os.environ.get(key)
    if not binary:
        pytest.fail(f"Set {key} to the pinned OpenCode binary")
    host = launch_host("v1", binary, {"plugin": [probe_package]})
    activate_host(host, "v1")
    assert (host["project"] / "host-probe.txt").read_text() == "server:v1\n"


@pytest.mark.parametrize("version", V1_VERSIONS)
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
    plugins = [package]
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


@pytest.mark.parametrize("version", V1_VERSIONS)
def test_v1_reuses_mcp_free_reviewer_location(launch_host, activate_host, model_server, version, tmp_path):
    binary = os.environ["OPENCODE_V1_" + version.replace(".", "_")]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    starts = tmp_path / "mcp-starts.txt"
    mcp_script = tmp_path / "mcp.py"
    mcp_script.write_text('''import json
import os
import sys
from pathlib import Path

with Path(sys.argv[1]).open("a") as output:
    output.write(str(os.getpid()) + "\\n")
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
              "serverInfo": {"name": "fixture", "version": "1"}} if request["method"] == "initialize" else {"tools": []}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
''', encoding="utf-8")
    provider = {"provider": {"fixture": {
        "npm": "@ai-sdk/openai-compatible", "name": "Fixture",
        "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {name: {"name": name, "limit": {"context": 32000, "output": 1000}}
                   for name in ["reviewer", "driver"]},
    }}, "mcp": {"fixture": {"type": "local", "command": [sys.executable, str(mcp_script), str(starts)]}}}
    project_config = {"plugin": [package], "permission": {"bash": "ask"}}
    host = launch_host("v1", binary, project_config,
        reviewer={"model": "fixture/reviewer", "timeoutMs": 15000, "reviewBudgetMs": 30000,
                  "retainReviewSessions": True}, global_config=provider)
    activate_host(host, "v1")

    def request(path, body=None, directory=None):
        query = urllib.parse.urlencode({"directory": str(directory or host["project"])})
        req = urllib.request.Request(host["url"] + path + "?" + query,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response) if response.status != 204 else None

    def inventory(directory):
        return request("/mcp", directory=directory)

    def start_count():
        return len(starts.read_text().splitlines())

    assert inventory(host["project"])["fixture"]["status"] == "connected"
    assert start_count() == 1

    def review(index, directory=None):
        session = request("/session", {"title": f"Fixture operation {index}"}, directory)
        result = request(f"/session/{session['id']}/message", {
            "model": {"providerID": "fixture", "modelID": "driver"},
            "parts": [{"type": "text", "text": "Run printf COMPATIBILITY_EXECUTED using bash exactly once"}],
        }, directory)
        messages = request(f"/session/{session['id']}/message", directory=directory)
        assert any(part.get("type") == "tool" and part.get("state", {}).get("status") == "completed"
                   and "COMPATIBILITY_EXECUTED" in part.get("state", {}).get("output", "")
                   for message in messages for part in message.get("parts", [])), result
        return session["id"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        operational_sessions = list(pool.map(review, range(4)))
    operational_sessions.extend(review(index) for index in range(4, 6))
    audit_path = host["root"] / "reviewer-audit.jsonl"

    def records_for(session_ids):
        deadline = time.monotonic() + 10
        records = []
        while time.monotonic() < deadline:
            try:
                records = [json.loads(line) for line in audit_path.read_text().splitlines()]
                records = [record for record in records if record.get("sessionID") in session_ids]
                if len(records) == len(session_ids):
                    return records
            except (OSError, json.JSONDecodeError):
                pass
            time.sleep(0.05)
        pytest.fail(f"Missing settled reviewer audit records: {records}")

    records = records_for(operational_sessions)
    assert all(record["outcome"] == "allow" and record["decisionSource"] == "llm-reviewer"
               and record["application"] == "reply-accepted" and record["schemaVersion"] == 3
               and record["hostVersion"] == version for record in records), records
    reviewer_ids = [record["reviewerSessionID"] for record in records]
    assert len(set(reviewer_ids)) == len(operational_sessions)
    locations = {request("/session/" + session_id)["directory"] for session_id in reviewer_ids}
    assert len(locations) == 1, locations
    reviewer_directory = next(iter(locations))
    assert reviewer_directory != str(host["project"])
    assert inventory(reviewer_directory) == {}
    assert start_count() == 1
    assert inventory(host["project"])["fixture"]["status"] == "connected"

    # A second project creates another backend that reasserts the same files.
    other = host["root"] / "other-project"
    other.mkdir()
    (other / "opencode.json").write_text(json.dumps(project_config), encoding="utf-8")
    assert inventory(other)["fixture"]["status"] == "connected"
    assert start_count() == 2
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(review, 6)
        second = pool.submit(review, 7, other)
        extra = [first.result(), second.result()]
    extra_records = records_for(extra)
    assert all(record["outcome"] == "allow" for record in extra_records)
    assert {request("/session/" + record["reviewerSessionID"])["directory"] for record in extra_records} == locations
    assert inventory(reviewer_directory) == {}
    assert start_count() == 2
    assert inventory(host["project"])["fixture"]["status"] == "connected"
    assert inventory(other)["fixture"]["status"] == "connected"


@pytest.mark.parametrize("version", V1_VERSIONS)
def test_v1_strips_late_plugin_mcp_from_reviewer_location(launch_host, activate_host, model_server, version, tmp_path):
    binary = os.environ["OPENCODE_V1_" + version.replace(".", "_")]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    starts = tmp_path / "mcp-starts.txt"
    mcp_script = tmp_path / "mcp.py"
    mcp_script.write_text('''import json
import os
import sys
from pathlib import Path

with Path(sys.argv[1]).open("a") as output:
    output.write(os.getcwd() + "\\n")
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
              "serverInfo": {"name": "fixture", "version": "1"}} if request["method"] == "initialize" else {"tools": []}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
''', encoding="utf-8")

    def hook(name):
        command = json.dumps([sys.executable, str(mcp_script), str(starts)])
        return ("config: async (cfg) => { cfg.mcp ??= {}; "
                f'cfg.mcp["{name}"] ??= {{ type: "local", command: {command}, enabled: true }}; }}')

    # Both sources apply after the reviewer location's own config, so their config
    # hooks run after the isolation bootstrap: the global plugin directory (object
    # entrypoint, as @upstash/context7-opencode ships) and OPENCODE_CONFIG_DIR, which
    # profile launchers set (legacy function entrypoint).
    plugin_dir = tmp_path / "late-plugin" / "config" / "opencode" / "plugin"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "dir-adder.js").write_text(
        'export default { id: "dir-adder", server: async () => ({ ' + hook("dir-fixture") + " }) };\n",
        encoding="utf-8")
    config_dir = tmp_path / "late-config"
    config_dir.mkdir()
    (config_dir / "env-adder.js").write_text("export default async () => ({ " + hook("env-fixture") + " });\n",
                                             encoding="utf-8")
    (config_dir / "opencode.json").write_text(json.dumps({"plugin": [str(config_dir / "env-adder.js")]}),
                                             encoding="utf-8")
    provider = {"provider": {"fixture": {
        "npm": "@ai-sdk/openai-compatible", "name": "Fixture",
        "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {name: {"name": name, "limit": {"context": 32000, "output": 1000}}
                   for name in ["reviewer", "driver"]},
    }}, "plugin": [package]}
    host = launch_host("v1", binary, {"permission": {"bash": "ask"}},
        reviewer={"model": "fixture/reviewer", "timeoutMs": 15000, "reviewBudgetMs": 30000,
                  "retainReviewSessions": True},
        global_config=provider, profile="late-plugin", extra_env={"OPENCODE_CONFIG_DIR": str(config_dir)})
    activate_host(host, "v1")

    def request(path, body=None, directory=None):
        query = urllib.parse.urlencode({"directory": str(directory or host["project"])})
        req = urllib.request.Request(host["url"] + path + "?" + query,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response) if response.status != 204 else None

    operational = request("/mcp")
    assert {name: server["status"] for name, server in operational.items()} == {
        "dir-fixture": "connected", "env-fixture": "connected"}, operational
    session = request("/session", {"title": "Fixture operation"})
    request(f"/session/{session['id']}/message", {
        "model": {"providerID": "fixture", "modelID": "driver"},
        "parts": [{"type": "text", "text": "Run printf COMPATIBILITY_EXECUTED using bash exactly once"}],
    })
    audit_path = host["root"] / "reviewer-audit.jsonl"
    record = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and record is None:
        try:
            record = next((entry for entry in map(json.loads, audit_path.read_text().splitlines())
                           if entry.get("sessionID") == session["id"]), None)
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    assert record and record["decisionSource"] == "llm-reviewer" and record["outcome"] == "allow", record
    reviewer_directory = request("/session/" + record["reviewerSessionID"])["directory"]
    assert reviewer_directory != str(host["project"])
    assert request("/mcp", directory=reviewer_directory) == {}
    started_in = {Path(line).resolve() for line in starts.read_text().splitlines()}
    assert started_in == {Path(host["project"]).resolve()}, starts.read_text()
