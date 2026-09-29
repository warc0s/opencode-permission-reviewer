"""Exercise the distributed reviewer through the real host and a synthetic model."""

import json
import os
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import urllib.request
import urllib.parse
import time

import pytest

V2_VERSIONS = (
    [os.environ["V2_HOST_VERSION"]]
    if os.environ.get("V2_HOST_VERSION")
    else ["2.0.3", "2.0.11", "2.0.15", "2.0.18"]
)
V2_CASES = [
    (version, "json_schema", outcome)
    for version in V2_VERSIONS
    for outcome in ("allow", "deny", "service")
] + (
    [
        ("2.0.3", "text", "allow"),
        ("2.0.3", "json_schema", "ambiguous"),
        ("2.0.3", "json_schema", "low-confidence-deny"),
        ("2.0.3", "json_schema", "prior-deny"),
        ("2.0.3", "json_schema", "later-deny"),
        ("2.0.3", "json_schema", "interrupted"),
        ("2.0.3", "json_schema", "retained"),
        ("2.0.3", "json_schema", "brake"),
        ("2.0.3", "json_schema", "schema-retry"),
        ("2.0.15", "json_schema", "interrupted"),
        ("2.0.15", "json_schema", "brake"),
    ]
    if not os.environ.get("V2_HOST_VERSION")
    else []
)


@pytest.fixture
def model_server():
    calls = []
    control = {"delay": 0}
    decision = {
        "version": 2, "outcome": "allow", "risk_level": "low",
        "user_authorization": "high", "scope_alignment": "aligned",
        "evidence_completeness": "sufficient", "rationale": "Synthetic harmless command review",
        "confidence": 0.99,
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append(body)
            calls[-1]["t"] = time.monotonic()
            time.sleep(control["delay"])
            tool_name = next((tool.get("function", {}).get("name") for tool in body.get("tools", [])
                             if tool.get("function", {}).get("name") in {"permission_reviewer_result", "StructuredOutput"}), None)
            structured = tool_name is not None
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_fixture",
                "type": "function", "function": {"name": tool_name,
                "arguments": json.dumps(decision)}}]} if structured else {"role": "assistant", "content": json.dumps(decision)}
            if structured and control.get("ambiguous"):
                delta["tool_calls"].append({"index": 1, "id": "call_invalid_fixture",
                    "type": "function", "function": {"name": tool_name,
                    "arguments": json.dumps({"outcome": "deny"})}})
            if structured and control.get("invalid_first") and sum(call.get("model") == "reviewer" for call in calls) == 1:
                delta["tool_calls"][0]["function"]["arguments"] = "{}"
            if body.get("model") == "driver":
                structured = not any(message.get("role") == "tool" for message in body.get("messages", []))
                native_tool = "shell" if any(tool.get("function", {}).get("name") == "shell" for tool in body.get("tools", [])) else "bash"
                native_tool = control.get("tool", native_tool)
                tool_arguments = {} if control.get("tool") else {"command": "printf COMPATIBILITY_EXECUTED", "description": "Print a synthetic fixture marker"}
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_operation",
                    "type": "function", "function": {"name": native_tool, "arguments": json.dumps(tool_arguments)}}]} if structured else {"role": "assistant", "content": "Completed."}
            common = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1, "model": body.get("model", "reviewer")}
            chunks = [{**common, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                      {**common, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if structured else "stop"}],
                       "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}]
            encoded = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                # Cancellation deliberately closes an in-flight model transport.
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield {"url": f"http://127.0.0.1:{server.server_port}/v1", "calls": calls, "decision": decision, "control": control}
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


@pytest.mark.parametrize("host_version,output_format,decision_outcome", V2_CASES)
def test_v2_reviewer_applies_and_cleans_up(launch_host, activate_host, model_server, host_version, output_format, decision_outcome, tmp_path):
    expected_effect = decision_outcome
    if decision_outcome == "ambiguous":
        model_server["control"]["ambiguous"] = True
        expected_effect = "ask"
    elif decision_outcome == "low-confidence-deny":
        model_server["decision"].update(outcome="deny", confidence=0.1)
        expected_effect = "deny"
    elif decision_outcome in {"prior-deny", "later-deny", "interrupted", "brake"}:
        expected_effect = "deny"
    elif decision_outcome in {"retained", "service"}:
        expected_effect = "allow"
    elif decision_outcome == "schema-retry":
        model_server["control"]["invalid_first"] = True
        expected_effect = "allow"
    else:
        model_server["decision"]["outcome"] = decision_outcome
    binary = os.environ[f"OPENCODE_V2_{host_version.replace('.', '_')}"]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    provider = {"providers": {"fixture": {
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
            "models": {"reviewer": {"name": "Fixture reviewer", "variants": [{"id": "max", "settings": {}}, {"id": "medium", "settings": {}}],
            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
            "limit": {"context": 32000, "output": 1000}}},
    }}}
    provider["providers"]["fixture"]["models"]["driver"] = {"name": "Driver", "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}, "limit": {"context": 32000, "output": 1000}}
    plugins = [package]
    if decision_outcome in {"prior-deny", "later-deny"}:
        other = tmp_path / "composition-plugin"
        other.mkdir()
        (other / "index.js").write_text('export default { id: "fixture-composition", async setup(ctx) { await ctx.permission.hook("evaluate", input => { input.effect = "deny"; input.message = "Fixture plugin denial"; }); } };')
        (other / "package.json").write_text(json.dumps({"name": "fixture-composition", "type": "module"}))
        plugins = [str(other), package] if decision_outcome == "prior-deny" else [package, str(other)]
    host = launch_host("v2", binary, {"plugins": plugins},
                       reviewer={"model": "fixture/reviewer", "timeoutMs": 5000, "reviewBudgetMs": 15000, "outputFormat": output_format, "retainReviewSessions": decision_outcome == "retained"},
                       global_config=provider, service=decision_outcome == "service")
    plugins = activate_host(host, "v2")
    assert "opencode-permission-reviewer" in json.dumps(plugins), plugins

    def request(path, body=None):
        req = urllib.request.Request(host["url"] + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            if response.status == 204:
                return None
            return json.load(response)

    session = request("/api/session", {"title": "Fixture operation", "location": {"directory": str(host["project"])},
        **({"model": {"providerID": "fixture", "id": "driver"}} if decision_outcome == "interrupted" else {}),
        "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
    session_id = session.get("data", session)["id"]
    wait_prefix = "/api/session" if host_version == "2.0.3" else "/api/experimental/session"
    if decision_outcome == "interrupted":
        model_server["control"]["delay"] = 1
        request(f"/api/session/{session_id}/prompt", {"text": "Print the fixture marker using shell once"})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not any(call.get("model") == "reviewer" for call in model_server["calls"]):
            time.sleep(0.02)
        assert any(call.get("model") == "reviewer" for call in model_server["calls"])
        request(f"/api/session/{session_id}/interrupt", {})
        request(f"{wait_prefix}/{session_id}/wait", {})
        context = request(f"/api/session/{session_id}/context")
        assert not any(part.get("type") == "tool" and part.get("state", {}).get("status") == "completed"
                       for message in context["data"] if message["type"] == "assistant" for part in message["content"]), context
    else:
        outcome = request(f"/api/session/{session_id}/permission", {
            # Evaluation metadata only: the critical string is never executed.
            "action": "shell", "resources": ["printf *"], "metadata": {"command": "rm -rf /" if decision_outcome == "brake" else "printf harmless"},
        })
    if decision_outcome == "prior-deny":
        assert outcome["data"]["effect"] == "deny"
        assert model_server["calls"] == []
        assert not (host["root"] / "reviewer-audit.jsonl").exists()
        return
    audit_path = host["root"] / "reviewer-audit.jsonl"
    deadline = time.monotonic() + 5
    records = []
    while time.monotonic() < deadline:
        if audit_path.exists():
            try:
                records = [json.loads(line) for line in audit_path.read_text().splitlines()]
            except json.JSONDecodeError:
                records = []
        if records:
            break
        time.sleep(0.02)
    assert records, "The completed evaluation must produce an audit record"
    if decision_outcome == "interrupted":
        assert records[-1]["outcome"] == "deny", records
        assert records[-1]["application"] == "cancelled", records
        return
    assert outcome["data"]["effect"] == expected_effect, records
    assert records[-1]["schemaVersion"] == 3
    assert records[-1]["application"] == ("human-pending" if expected_effect == "ask" else "evaluation-returned")
    if decision_outcome == "brake":
        assert records[-1]["decisionSource"] == "emergency-brake"
        assert model_server["calls"] == []
        return
    assert model_server["calls"]
    for call in model_server["calls"]:
        assert {tool["function"]["name"] for tool in call.get("tools", [])} <= {"permission_reviewer_result"}
    if decision_outcome == "retained":
        reviewer_id = records[-1]["reviewerSessionID"]
        retained = request("/api/session/" + reviewer_id)["data"]
        isolated = Path(retained["location"]["directory"])
        assert isolated.parent == Path(tempfile.gettempdir()) and isolated.name.startswith("opencode-reviewer-")
        assert isolated != host["project"]
        assert (isolated / "index.js").exists()
        assert "permission_reviewer_result" in json.dumps(request(f"/api/session/{reviewer_id}/context"))
        with urllib.request.urlopen(urllib.request.Request(host["url"] + "/api/session/" + reviewer_id,
                headers=host["headers"], method="DELETE"), timeout=5):
            pass
        host["stop"]()
        shutil.rmtree(isolated, ignore_errors=True)
        return
    with pytest.raises(urllib.error.HTTPError) as failure:
        request("/api/session/" + records[-1]["reviewerSessionID"])
    assert failure.value.code == 404
    if output_format == "json_schema" and decision_outcome == "allow":
        operation = request("/api/session", {"title": "Real shell fixture", "location": {"directory": str(host["project"])},
            "model": {"providerID": "fixture", "id": "driver"},
            "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
        operation_id = operation.get("data", operation)["id"]
        request(f"/api/session/{operation_id}/prompt", {"text": "Print the fixture marker with shell exactly once"})
        request(f"{wait_prefix}/{operation_id}/wait", {})
        context = request(f"/api/session/{operation_id}/context")
        assert "COMPATIBILITY_EXECUTED" in json.dumps(context), context
        assert any(part.get("type") == "tool" and part.get("name") == "shell" and part.get("state", {}).get("status") == "completed"
                   for message in context["data"] if message["type"] == "assistant" for part in message["content"]), context


@pytest.mark.parametrize("host_version", V2_VERSIONS)
def test_v2_reuses_mcp_free_reviewer_location(launch_host, activate_host, model_server, host_version, tmp_path):
    binary = os.environ[f"OPENCODE_V2_{host_version.replace('.', '_')}"]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    starts = tmp_path / "mcp-starts.txt"
    mcp = tmp_path / "mcp.py"
    mcp.write_text('''import json
import os
import sys
from pathlib import Path

with Path(sys.argv[1]).open("a") as output:
    output.write(str(os.getpid()) + "\\n")

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
              "serverInfo": {"name": "fixture", "version": "1"}} if request["method"] == "initialize" else {"tools": []}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
''', encoding="utf-8")
    provider = {"providers": {"fixture": {
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {"reviewer": {"name": "Fixture reviewer", "variants": [{"id": "medium", "settings": {}}],
            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
            "limit": {"context": 32000, "output": 1000}}},
    }}, "mcp": {"servers": {"fixture": {"type": "local", "command": [sys.executable, str(mcp), str(starts)]}}}}
    # Reviews must settle within the reviewer budget even on loaded runners;
    # the property under test is reviewer location reuse, not review latency.
    host = launch_host("v2", binary, {"plugins": [package]},
                       reviewer={"model": "fixture/reviewer", "timeoutMs": 15000,
                                 "reviewBudgetMs": 30000, "retainReviewSessions": True,
                                 "debug": True},
                       global_config=provider)
    activate_host(host, "v2")

    def request(path, body=None):
        req = urllib.request.Request(host["url"] + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response) if response.status != 204 else None

    def mcp_servers(directory):
        query = urllib.parse.urlencode({"location[directory]": str(directory)})
        response = request("/api/mcp?" + query)
        return response.get("data", response)

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not starts.exists():
        mcp_servers(host["project"])
        time.sleep(0.05)
    assert starts.exists(), "Operational MCP did not start"
    assert len(starts.read_text().splitlines()) == 1

    def dump_diagnostics(index, elapsed):
        print(f"\n[diag] review({index}) left the permission pending after {elapsed:.2f}s "
              f"with {len(calls)} model calls", flush=True)
        for call in calls[-6:]:
            print(f"[diag-call] t={call.get('t')} model={call.get('model')} "
                  f"messages={len(call.get('messages', []))}", flush=True)
        log = host["root"] / "server.log"
        if log.exists():
            lines = log.read_text(errors="replace").splitlines()
            print("\n".join(f"[server.log] {line}" for line in lines[-120:]), flush=True)
        audit = host["root"] / "reviewer-audit.jsonl"
        if audit.exists():
            print(f"[audit]\n{audit.read_text()}", flush=True)

    def review(index):
        session = request("/api/session", {"title": f"Fixture operation {index}",
            "location": {"directory": str(host["project"])},
            "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
        session_id = session.get("data", session)["id"]
        started = time.monotonic()
        outcome = request(f"/api/session/{session_id}/permission", {
            "action": "shell", "resources": ["printf *"],
            "metadata": {"command": f"printf fixture-{index}"},
        })
        if outcome["data"]["effect"] != "allow":
            dump_diagnostics(index, time.monotonic() - started)
        assert outcome["data"]["effect"] == "allow", outcome
        return session_id

    operational_sessions = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        operational_sessions.extend(pool.map(review, range(4)))
    operational_sessions.extend(review(index) for index in range(4, 7))

    audit_path = host["root"] / "reviewer-audit.jsonl"
    def audit_records():
        try:
            return [json.loads(line) for line in audit_path.read_text().splitlines()]
        except (OSError, json.JSONDecodeError):
            return []

    deadline = time.monotonic() + 10
    records = []
    while time.monotonic() < deadline:
        records = audit_records()
        records = [record for record in records if record.get("sessionID") in operational_sessions]
        if len(records) == len(operational_sessions):
            break
        time.sleep(0.05)
    assert len(records) == len(operational_sessions), records
    reviewer_ids = [record["reviewerSessionID"] for record in records]
    assert len(set(reviewer_ids)) == len(reviewer_ids)
    locations = {request("/api/session/" + session_id)["data"]["location"]["directory"]
                 for session_id in reviewer_ids}
    assert len(locations) == 1, locations
    reviewer_directory = next(iter(locations))
    assert reviewer_directory != str(host["project"])
    assert mcp_servers(reviewer_directory) == []
    assert len(starts.read_text().splitlines()) == 1, starts.read_text()
    assert mcp_servers(host["project"])[0]["status"]["status"] == "connected"
    for session_id in reviewer_ids:
        req = urllib.request.Request(host["url"] + "/api/session/" + session_id,
            headers=host["headers"], method="DELETE")
        with urllib.request.urlopen(req, timeout=5):
            pass
    new_directory = None
    if tuple(map(int, host_version.split("."))) >= (2, 0, 18):
        reload_request = urllib.request.Request(host["url"] + "/api/location/reload",
            data=b"", headers=host["headers"], method="POST")
        with urllib.request.urlopen(reload_request, timeout=30) as response:
            assert response.status == 204
        assert mcp_servers(reviewer_directory) == []
        reloaded_session = review(7)
        deadline = time.monotonic() + 10
        reloaded_record = None
        while time.monotonic() < deadline:
            reloaded_record = next((record for record in audit_records()
                if record.get("sessionID") == reloaded_session), None)
            if reloaded_record:
                break
            time.sleep(0.05)
        assert reloaded_record
        new_reviewer_id = reloaded_record["reviewerSessionID"]
        new_directory = request("/api/session/" + new_reviewer_id)["data"]["location"]["directory"]
        assert new_directory != reviewer_directory
        assert mcp_servers(new_directory) == []
        req = urllib.request.Request(host["url"] + "/api/session/" + new_reviewer_id,
            headers=host["headers"], method="DELETE")
        with urllib.request.urlopen(req, timeout=5):
            pass
    host["stop"]()
    shutil.rmtree(reviewer_directory, ignore_errors=True)
    if new_directory:
        shutil.rmtree(new_directory, ignore_errors=True)
