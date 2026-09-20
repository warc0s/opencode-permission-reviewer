"""Isolated real-host harnesses; never inherit provider credentials or user config."""

import base64
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import urllib.parse

import pytest


@pytest.fixture
def probe_package(tmp_path):
    source = Path(__file__).parent / "probe"
    target = tmp_path / "probe"
    shutil.copytree(source, target)
    return str(target)


@pytest.fixture
def activate_host():
    def activate(host, generation):
        route = "/path" if generation == "v1" else "/api/plugin"
        key = "directory" if generation == "v1" else "location[directory]"
        query = urllib.parse.urlencode({key: str(host["project"])})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            request = urllib.request.Request(
                host["url"] + route + "?" + query, headers=host["headers"]
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
            if generation == "v1":
                return result
            plugins = result.get("data", result)
            local = [plugin for plugin in plugins if plugin.get("source", {}).get("type") == "local"]
            failed = [plugin for plugin in local if plugin.get("state", {}).get("status") == "failed"]
            if failed:
                pytest.fail(f"Host plugin activation failed: {failed}")
            if local and all(plugin.get("state", {}).get("status") == "active" for plugin in local):
                return result
            time.sleep(0.1)
        pytest.fail("Host plugin activation timed out")
    return activate


@pytest.fixture
def launch_host(tmp_path):
    processes = []

    def launch(generation, binary, config, reviewer=None, global_config=None, profile=None, service=False):
        executable = shutil.which(binary)
        if executable is None:
            pytest.fail(f"Host binary does not exist: {binary}")
        if profile is not None and not re.fullmatch(r"[a-z0-9-]+", profile):
            pytest.fail("Invalid disposable profile name")
        root = tmp_path / (profile or generation)
        root.mkdir(exist_ok=profile is not None)
        project = root / "project"
        project.mkdir(exist_ok=profile is not None)
        home = root / "home"
        home.mkdir(exist_ok=profile is not None)
        env = {
            "PATH": os.defpath,
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"),
            "TERM": "xterm-256color",
        }
        if config is not None:
            (project / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
        if global_config is not None:
            config_dir = root / "config" / "opencode"
            config_dir.mkdir(parents=True, exist_ok=True)
            (config_dir / "opencode.json").write_text(json.dumps(global_config), encoding="utf-8")
        if reviewer is not None:
            reviewer_dir = home / ".config" / "opencode"
            reviewer_dir.mkdir(parents=True, exist_ok=True)
            (reviewer_dir / "permission-reviewer.jsonc").write_text(json.dumps({
                **reviewer, "auditPath": str(root / "reviewer-audit.jsonl"),
            }), encoding="utf-8")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        if generation == "v2":
            if not service:
                env["OPENCODE_PERMISSION_REVIEWER_HOST_URL"] = f"http://127.0.0.1:{port}"
            env["OPENCODE_PASSWORD"] = "synthetic-local-host-password"
        log = (root / "server.log").open("w+", encoding="utf-8")
        process = subprocess.Popen(
            [executable, "serve", "--hostname", "127.0.0.1", "--port", str(port), *(["--service"] if service else [])],
            cwd=project,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        processes.append((process, log))
        def stop():
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        url = f"http://127.0.0.1:{port}"
        health = "/global/health" if generation == "v1" else "/api/location"
        deadline = time.monotonic() + 45
        headers = {} if generation == "v1" else {"Authorization": "Basic " + base64.b64encode(
            b"opencode:synthetic-local-host-password"
        ).decode()}
        service_discovered = False

        def safe_log():
            log.seek(0)
            return re.sub(r"server password \S+", "server password [redacted]", log.read())

        while time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail(f"Host exited before becoming ready:\n{safe_log()}")
            if service and not service_discovered:
                registration = Path(env["XDG_STATE_HOME"]) / "opencode" / "service.json"
                if registration.exists():
                    try:
                        connection = json.loads(registration.read_text())
                        url = connection["url"]
                        password = connection.get("password")
                        headers = {} if password is None else {"Authorization": "Basic " + base64.b64encode(
                            ("opencode:" + password).encode()
                        ).decode()}
                        service_discovered = True
                    except (KeyError, json.JSONDecodeError, OSError):
                        pass
            if generation == "v2" and not headers:
                log.seek(0)
                match = re.search(r"server password (\S+)", log.read())
                if match:
                    auth = base64.b64encode(("opencode:" + match[1]).encode()).decode()
                    headers["Authorization"] = "Basic " + auth
            try:
                request = urllib.request.Request(url + health, headers=headers)
                with urllib.request.urlopen(request, timeout=1) as response:
                    if response.status == 200:
                        return {"url": url, "root": root, "project": project, "env": env,
                                "headers": headers, "stop": stop}
            except (OSError, ValueError):
                time.sleep(0.1)
        pytest.fail(f"Host readiness timed out:\n{safe_log()}")

    yield launch
    for process, log in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log.close()
