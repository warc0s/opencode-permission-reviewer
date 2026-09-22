"""Render the actual CLI plugin in a disposable PTY attached to a fresh host."""

import fcntl
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import termios
import time
from threading import Thread
import urllib.parse
import urllib.request
import pytest

V2_VERSIONS = (
    [os.environ["V2_HOST_VERSION"]]
    if os.environ.get("V2_HOST_VERSION")
    else ["2.0.3", "2.0.11", "2.0.14"]
)

from test_v2_reviewer import model_server  # noqa: F401



@contextmanager
def terminal(arguments, env):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    proc = subprocess.Popen(arguments, env={**env, "COLORTERM": "truecolor"},
                            stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    stop = False

    def read_terminal():
        while not stop:
            if not select.select([master], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
                if not chunk:
                    return
                output.extend(chunk)
                for query, response in [(b"\x1b[c", b"\x1b[?1;2c"), (b"\x1b[>c", b"\x1b[>0;276;0c"),
                                        (b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[?u", b"\x1b[?0u")]:
                    if query in chunk:
                        os.write(master, response)
            except OSError:
                return

    reader = Thread(target=read_terminal, daemon=True)
    reader.start()
    try:
        yield output, proc
    finally:
        stop = True
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        reader.join(timeout=1)
        os.close(master)

@pytest.mark.parametrize("generation,version", [
    ("v1", "1.18.29"),
    ("v1", "1.18.30"),
    ("v1", "1.18.31"),
    ("v1", "1.18.32"),
    *(("v2", version) for version in V2_VERSIONS),
])
def test_tui_renders_review_state(launch_host, activate_host, model_server, generation, version):
    binary = os.environ[f"OPENCODE_{generation.upper()}_{version.replace('.', '_')}"]
    package = os.environ.get("PLUGIN_PACKAGE_PATH", str(Path(__file__).resolve().parents[2]))
    provider = {"providers": {"fixture": {
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
        "models": {"reviewer": {"name": "Fixture reviewer", "variants": [{"id": "max", "settings": {}}],
            "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
            "limit": {"context": 32000, "output": 1000}}},
    }}}
    if generation == "v1":
        provider = {"provider": {"fixture": {"npm": "@ai-sdk/openai-compatible", "name": "Fixture",
            "options": {"baseURL": model_server["url"], "apiKey": "synthetic-fixture"},
            "models": {name: {"name": name, "limit": {"context": 32000, "output": 1000}} for name in ["reviewer", "driver"]},
        }}}
    config = {"plugins": [package]} if generation == "v2" else {"plugin": [[package, {"model": "fixture/reviewer"}]], "permission": {"bash": "ask"}}
    host = launch_host(generation, binary, config,
        reviewer={"model": "fixture/reviewer", "timeoutMs": 10000, "reviewBudgetMs": 20000}, global_config=provider)
    activate_host(host, generation)

    def request(path, body=None):
        if generation == "v1":
            path += "?" + urllib.parse.urlencode({"directory": str(host["project"])})
        req = urllib.request.Request(host["url"] + path, data=None if body is None else json.dumps(body).encode(),
            headers={**host["headers"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    session = request("/api/session" if generation == "v2" else "/session", {"title": "Reviewer UI fixture", "location": {"directory": str(host["project"])},
        "permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]})
    session_id = session.get("data", session)["id"]
    cli_config = host["root"] / "config" / "opencode" / ("cli.json" if generation == "v2" else "tui.json")
    cli_config.write_text(json.dumps({"plugins" if generation == "v2" else "plugin": [package]}))
    arguments = [binary, "--server", host["url"], "--session", session_id, str(host["project"])] if generation == "v2" else [binary, "attach", host["url"], "--session", session_id, "--dir", str(host["project"])]
    with ExitStack() as stack:
        terminals = [stack.enter_context(terminal(arguments, host["env"])) for _ in range(2 if generation == "v2" else 1)]
        for output, proc in terminals:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and b"Reviewer UI fixture" not in output and proc.poll() is None:
                time.sleep(0.1)
            assert proc.poll() is None, output.decode("utf-8", errors="replace")[-6000:]
        model_server["control"]["delay"] = 1
        if generation == "v2":
            outcome = request(f"/api/session/{session_id}/permission", {"action": "shell", "resources": ["printf *"], "metadata": {"command": "printf harmless"}})
            assert outcome["data"]["effect"] == "allow"
        else:
            request(f"/session/{session_id}/message", {"model": {"providerID": "fixture", "modelID": "driver"},
                "parts": [{"type": "text", "text": "Print the fixture marker using bash once"}]})
        time.sleep(1)
        for index, (output, _proc) in enumerate(terminals):
            text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode("utf-8", errors="replace"))
            (host["root"] / f"terminal-{index}.txt").write_text(text)
            assert "Reviewing this permission" in text, text[-6000:]
            assert "Review approved" in text, text[-6000:]
