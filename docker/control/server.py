#!/usr/bin/env python3
import http.client
import json
import os
import re
import socket
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlparse

DOCKER_SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
PROJECT_NAME = os.environ.get("COMPOSE_PROJECT_NAME", "").strip()
SERVICE_NAME = os.environ.get("NESTBOX_CONTROL_SERVICE", "control")
MAX_BODY_BYTES = 128 * 1024
MAX_COMMAND_PARTS = 256
MAX_COMMAND_BYTES = 64 * 1024
LOG_OUTPUT = os.environ.get("NESTBOX_CONTROL_LOG_OUTPUT", "text").lower()
LOG_MAX_BYTES = int(os.environ.get("NESTBOX_CONTROL_LOG_MAX_BYTES", str(256 * 1024)))
LOG_LOCK = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def run_id(prefix):
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:12]}"


def log_event(event, **fields):
    safe = dict(fields)
    command = safe.pop("command", None)
    if isinstance(command, list) and command:
        safe["commandName"] = os.path.basename(command[0])
        safe["argsCount"] = len(command) - 1
    safe.pop("args", None)
    record = {
        "timestamp": now_iso(),
        "schemaVersion": 1,
        "service": "nestbox-control",
        "event": event,
        **safe,
    }
    with LOG_LOCK:
        sys.stderr.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        sys.stderr.flush()


def log_output(identifier, stream, content):
    if LOG_OUTPUT != "text" or not content:
        return
    data = content if isinstance(content, bytes) else str(content).encode()
    captured = data[:LOG_MAX_BYTES].decode("utf-8", "replace")
    for line in captured.splitlines():
        log_event("command.output", runId=identifier, stream=stream, message=line)
    if len(data) > LOG_MAX_BYTES:
        log_event("command.output.truncated", runId=identifier, stream=stream, capturedBytes=LOG_MAX_BYTES, totalBytes=len(data))


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


def docker_request(method, path, body=None, max_bytes=None):
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    connection = UnixHTTPConnection(DOCKER_SOCKET)
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        if max_bytes is None:
            data = response.read()
        else:
            chunks = []
            remaining = max_bytes
            total_bytes = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if remaining > 0:
                    chunks.append(chunk[:remaining])
                    remaining -= min(len(chunk), remaining)
            data = b"".join(chunks)
    finally:
        connection.close()
    if response.status >= 400:
        raise RuntimeError(f"Docker API returned HTTP {response.status}: {data.decode('utf-8', 'replace')}")
    if not data:
        return (None, 0) if max_bytes is not None else None
    value = json.loads(data) if "application/json" in response.getheader("Content-Type", "") else data
    return (value, total_bytes) if max_bytes is not None else value


def project_containers():
    containers = docker_request("GET", "/containers/json?all=1") or []
    return [item for item in containers if (item.get("Labels") or {}).get("com.docker.compose.project") == PROJECT_NAME]


def names(container):
    labels = container.get("Labels") or {}
    values = {labels.get("com.docker.compose.service", ""), container.get("Id", "")}
    values.update(name.strip("/") for name in container.get("Names") or [])
    return {value for value in values if value}


def find_by_name(name):
    return next((container for container in project_containers() if name in names(container)), None)


def find_by_ip(ip):
    for container in project_containers():
        details = docker_request("GET", f"/containers/{container['Id']}/json")
        networks = (details.get("NetworkSettings") or {}).get("Networks") or {}
        if any(ip in {network.get("IPAddress"), network.get("GlobalIPv6Address")} for network in networks.values()):
            return container
    return None


def truthy(labels, key):
    return str(labels.get(key, "")).lower() in {"1", "true", "yes", "on"}


def service(container):
    return ((container or {}).get("Labels") or {}).get("com.docker.compose.service", "")


def is_root_user(user):
    account = str(user).split(":", 1)[0].strip().lower()
    return account == "root" or bool(re.fullmatch(r"\+?0+", account))


def policy_error(source, target, user, configured_user=""):
    if not source:
        return "caller container was not found in this Compose project"
    source_labels = source.get("Labels") or {}
    target_labels = target.get("Labels") or {}
    if service(source) == SERVICE_NAME:
        return "control service cannot call itself through the API"
    if truthy(source_labels, "nestbox.exec.deny-source"):
        return f"source {service(source)} is denied by label"
    if truthy(target_labels, "nestbox.exec.deny-target"):
        return f"target {service(target)} is denied by label"
    if not truthy(source_labels, "nestbox.exec.allow-source"):
        return f"source {service(source)} is not allowed to call exec"
    if not truthy(target_labels, "nestbox.exec.allow-target"):
        return f"target {service(target)} does not allow inbound exec"
    allowed = {item.strip() for item in str(source_labels.get("nestbox.exec.targets", "")).split(",") if item.strip()}
    if not allowed:
        return f"source {service(source)} has no allowed exec targets"
    if "*" not in allowed and names(target).isdisjoint(allowed):
        return f"source {service(source)} is not allowed to exec into {service(target)}"
    if is_root_user(user) and not truthy(target_labels, "nestbox.exec.allow-root"):
        return f"target {service(target)} does not allow root exec"
    account = str(user).split(":", 1)[0].strip().lower()
    configured_account = str(configured_user).split(":", 1)[0].strip().lower()
    if account and not re.fullmatch(r"\+?\d+", account) and account != configured_account and not truthy(target_labels, "nestbox.exec.allow-root"):
        return f"target {service(target)} does not allow named user overrides"
    return ""


def valid_command(command):
    return (isinstance(command, list) and 0 < len(command) <= MAX_COMMAND_PARTS
            and all(isinstance(part, str) and "\0" not in part for part in command)
            and sum(len(part.encode()) for part in command) <= MAX_COMMAND_BYTES)


class Handler(BaseHTTPRequestHandler):
    server_version = "nestbox-control/0.6"

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, fmt, *args):
        log_event("http.access", client=self.address_string(), message=fmt % args)

    def send_json(self, status, value):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def caller(self):
        return find_by_ip(self.client_address[0])

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("transfer encoding is not supported")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("request body is too large")
        value = json.loads(self.rfile.read(length)) if length else {}
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            try:
                docker_request("GET", "/_ping")
                self.send_json(200, {"ok": True, "dockerSocketAccess": True})
            except Exception as error:
                self.send_json(503, {"ok": False, "dockerSocketAccess": False, "error": str(error)})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = self.body()
        except Exception as error:
            self.send_json(400, {"error": str(error)})
            return
        path = urlparse(self.path).path
        if path.startswith("/containers/") and path.endswith("/exec"):
            self.container_exec(unquote(path[len("/containers/"):-len("/exec")]).strip("/"), body)
        else:
            self.send_json(404, {"error": "not found"})

    def container_exec(self, target_name, body):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", target_name):
            self.send_json(400, {"error": "invalid target name"}); return
        target, source = find_by_name(target_name), self.caller()
        if not target:
            self.send_json(404, {"error": "target container was not found in this Compose project"}); return
        command, user, workdir = body.get("command"), str(body.get("user", "")), str(body.get("workdir", ""))
        if not valid_command(command):
            self.send_json(400, {"error": "command must be a bounded, non-empty string array"}); return
        if not workdir.startswith("/") or "\0" in workdir:
            self.send_json(400, {"error": "workdir must be an absolute container path"}); return
        effective_user = user
        details = docker_request("GET", f"/containers/{quote(target['Id'])}/json") or {}
        configured_user = str((details.get("Config") or {}).get("User", ""))
        if not effective_user:
            effective_user = configured_user or "0"
        error = policy_error(source, target, effective_user, configured_user)
        if error:
            self.send_json(403, {"error": error}); return
        identifier, detached = run_id("exec"), bool(body.get("detach", False))
        try:
            created = docker_request("POST", f"/containers/{quote(target['Id'])}/exec", {"AttachStdout": True, "AttachStderr": True, "Cmd": command, "Tty": True, "User": user, "WorkingDir": workdir})
            if detached:
                def finish():
                    output, total_bytes = docker_request("POST", f"/exec/{created['Id']}/start", {"Detach": False, "Tty": True}, LOG_MAX_BYTES)
                    output = output or b""
                    info = docker_request("GET", f"/exec/{created['Id']}/json") or {}
                    log_output(identifier, "exec.output", output)
                    log_event("exec.complete", runId=identifier, source=service(source), target=service(target), command=command, detached=True, exitCode=info.get("ExitCode"), outputTruncated=total_bytes > len(output), outputTotalBytes=total_bytes)
                threading.Thread(target=finish, daemon=True).start()
                self.send_json(202, {"runId": identifier, "execId": created["Id"], "detached": True}); return
            output, total_bytes = docker_request("POST", f"/exec/{created['Id']}/start", {"Detach": False, "Tty": True}, LOG_MAX_BYTES)
            output = output or b""
            info = docker_request("GET", f"/exec/{created['Id']}/json") or {}
            log_output(identifier, "exec.output", output)
            self.send_json(200, {"runId": identifier, "exitCode": info.get("ExitCode"), "output": output.decode("utf-8", "replace"), "outputTruncated": total_bytes > len(output), "outputTotalBytes": total_bytes})
        except Exception as error:
            log_event("exec.error", runId=identifier, source=service(source), target=service(target), command=command, error=str(error))
            self.send_json(502, {"error": str(error)})


def main():
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", PROJECT_NAME):
        raise SystemExit("COMPOSE_PROJECT_NAME must be a non-empty lowercase project slug")
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("NESTBOX_CONTROL_PORT", "4088"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
