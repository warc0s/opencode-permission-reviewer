"""Exercise the distributed reviewer through the real host and a synthetic model."""

import json
import os
import shutil
import tempfile
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
    else ["2.0.3", "2.0.11", "2.0.14"]
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
        ("2.0.14", "json_schema", "interrupted"),
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
        "models": {"reviewer": {"name": "Fixture reviewer", "variants": [{"id": "max", "settings": {}}],
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
        assert not (isolated / "index.js").exists()
        assert "permission_reviewer_result" in json.dumps(request(f"/api/session/{reviewer_id}/context"))
        with urllib.request.urlopen(urllib.request.Request(host["url"] + "/api/session/" + reviewer_id,
                headers=host["headers"], method="DELETE"), timeout=5):
            pass
        shutil.rmtree(isolated)
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
