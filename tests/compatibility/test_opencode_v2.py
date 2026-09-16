"""OpenCode product V2 process harness, not the historical V1 SDK /v2 path."""

import json
import os
from pathlib import Path
import shutil
import subprocess

from test_v2_reviewer import model_server  # noqa: F401

import pytest


def test_v2_isolated_server(launch_host, activate_host, probe_package):
    binary = os.environ.get("OPENCODE_V2_2_0_3")
    if not binary:
        pytest.fail("Set OPENCODE_V2_2_0_3 to the pinned OpenCode binary")
    host = launch_host("v2", binary, {"plugins": [probe_package]})
    activate_host(host, "v2")
    assert (host["project"] / "host-probe.txt").read_text() == "setup:v2:2.0.3\n"
    capabilities = json.loads((host["project"] / "host-capabilities.json").read_text())
    assert capabilities == {
        "sessionRemove": False,
        "sessionGenerate": True,
        "generateText": True,
        "generateKeys": ["text"],
    }


def test_native_context_fork_and_form_contracts(launch_host, model_server):
    binary = os.environ["OPENCODE_V2_2_0_3"]
    provider = {"providers": {"fixture": {
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {"reviewer": {"name": "Reviewer", "capabilities": {"tools": True, "input": ["text"], "output": ["text"]}, "limit": {"context": 32000, "output": 1000}}},
    }}}
    host = launch_host("v2", binary, {}, global_config=provider)
    script = Path(__file__).with_name("capture-contracts.ts")
    captured = subprocess.run([shutil.which("bun"), str(script), host["url"], str(host["project"])],
        env=host["env"], capture_output=True, text=True, timeout=30)
    assert captured.returncode == 0, captured.stderr
    contract = json.loads(captured.stdout)
    assert contract["fork"]["sourceMatches"] is True
    assert contract["formReplied"]["answer"] == {"scope": "read"}
    assert any(message.get("matchesAdmission") for message in contract["context"])
    expected = Path(__file__).parent / "fixtures" / "v2-native.json"
    assert contract == json.loads(expected.read_text())
    (host["root"] / "native-contracts.json").write_text(json.dumps(contract, indent=2))
