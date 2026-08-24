#!/usr/bin/env python3
import hashlib
import http.client
import json
import os
import re
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

DOCKER_SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
WORKSPACE_PATH = os.environ.get("WORKSPACE_PATH", "/workspace")
PROJECT_NAME = os.environ.get("COMPOSE_PROJECT_NAME", "").strip()
SERVICE_NAME = os.environ.get("NESTBOX_CONTROL_SERVICE", "control")
HOST_TIMEOUT = int(os.environ.get("NESTBOX_HOST_RUNNER_TIMEOUT", "3600"))
HOST_HEARTBEAT_TTL = int(os.environ.get("NESTBOX_HOST_RUNNER_HEARTBEAT_TTL", "10"))
HOST_LONG_POLL_TIMEOUT = int(os.environ.get("NESTBOX_HOST_LONG_POLL_TIMEOUT", "25"))
MAX_HOST_JOBS = int(os.environ.get("NESTBOX_MAX_HOST_JOBS", "100"))
MAX_BODY_BYTES = 128 * 1024
MAX_HOST_BODY_BYTES = 64 * 1024 * 1024
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


def allows_npm(source):
    labels = (source or {}).get("Labels") or {}
    return bool(source) and truthy(labels, "nestbox.npm.allow") and not truthy(labels, "nestbox.exec.deny-source")


def package_scripts():
    path = os.path.join(WORKSPACE_PATH, "package.json")
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as stream:
        document = json.load(stream)
    scripts = document.get("scripts", {})
    if not isinstance(scripts, dict):
        raise ValueError("package.json scripts must be an object")
    return {str(name): str(command) for name, command in scripts.items()}


class HostBroker:
    def __init__(self):
        self.condition = threading.Condition()
        self.pending = []
        self.jobs = {}
        self.runner = {}
        self.gone = {}

    def _validate_ids(self, runner_id, session_id):
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", runner_id):
            raise ValueError("invalid runner ID")
        if not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", session_id):
            raise ValueError("invalid session ID")

    def connect(self, runner_id, session_id, metadata):
        self._validate_ids(runner_id, session_id)
        now = time.monotonic()
        with self.condition:
            active_id = self.runner.get("id")
            active_age = now - self.runner.get("seen", 0)
            if active_id and active_id != runner_id and active_age <= HOST_HEARTBEAT_TTL:
                raise PermissionError("another host runner is active")
            if active_id and active_id != runner_id:
                for record in self.jobs.values():
                    if record.get("runnerId") == active_id and record.get("result") is None:
                        record["result"] = {
                            "jobId": record["job"]["jobId"],
                            "exitCode": 1,
                            "stdout": "",
                            "stderr": "The assigned host runner disconnected before returning a result.",
                            "interrupted": True,
                        }
            self.runner = {
                "id": runner_id,
                "sessionId": session_id,
                "seen": now,
                "pid": metadata.get("pid"),
                "platform": metadata.get("platform"),
                "hostname": metadata.get("hostname"),
            }
            self.condition.notify_all()

    def touch(self, runner_id, session_id):
        self._validate_ids(runner_id, session_id)
        with self.condition:
            if self.runner.get("id") != runner_id or self.runner.get("sessionId") != session_id:
                raise PermissionError("host runner session was superseded")
            self.runner["seen"] = time.monotonic()
            self.condition.notify_all()

    def status(self):
        with self.condition:
            if not self.runner:
                return {"available": False}
            age = max(0, time.monotonic() - self.runner["seen"])
            return {
                "available": age <= HOST_HEARTBEAT_TTL,
                "ageSeconds": round(age, 3),
                "pid": self.runner.get("pid"),
                "platform": self.runner.get("platform"),
                "hostname": self.runner.get("hostname"),
            }

    def enqueue(self, job):
        with self.condition:
            if len(self.jobs) >= MAX_HOST_JOBS:
                raise RuntimeError("too many host jobs are pending")
            self.jobs[job["jobId"]] = {"job": job, "result": None, "runnerId": None}
            self.pending.append(job["jobId"])
            self.condition.notify_all()

    def next(self, runner_id, session_id, timeout):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                if self.runner.get("id") != runner_id or self.runner.get("sessionId") != session_id:
                    raise PermissionError("host runner session was superseded")
                self.runner["seen"] = time.monotonic()
                for record in self.jobs.values():
                    if record.get("runnerId") == runner_id and record.get("result") is None:
                        return record["job"]
                if self.pending:
                    identifier = self.pending.pop(0)
                    record = self.jobs.get(identifier)
                    if record:
                        record["runnerId"] = runner_id
                        return record["job"]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.condition.wait(min(1, remaining))

    def complete(self, runner_id, session_id, identifier, result):
        with self.condition:
            if self.runner.get("id") != runner_id or self.runner.get("sessionId") != session_id:
                raise PermissionError("host runner session was superseded")
            serialized = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            fingerprint = hashlib.sha256(serialized).hexdigest()
            record = self.jobs.get(identifier)
            terminal = self.gone.get(identifier)
            if not record and terminal:
                if terminal.get("fingerprint") == fingerprint:
                    return True
                if terminal.get("fingerprint"):
                    raise RuntimeError("conflicting host result replay")
                raise FileNotFoundError(terminal["error"])
            if not record:
                raise FileNotFoundError("host job is no longer available")
            if record.get("runnerId") != runner_id:
                raise ValueError("host job belongs to another runner")
            if record.get("result") is not None:
                if record.get("fingerprint") == fingerprint:
                    return True
                raise RuntimeError("conflicting host result replay")
            if result.get("jobId") != identifier:
                raise ValueError("host result contains a mismatched job ID")
            job = record["job"]
            if job["type"] == "npm.run":
                if not isinstance(result.get("exitCode"), int) or not isinstance(result.get("stdout"), str) or not isinstance(result.get("stderr"), str):
                    raise ValueError("invalid npm run result")
            elif job["type"] == "npm.scripts.request":
                if result.get("status") != "confirmation_required" or result.get("requestId") != job.get("requestId") or result.get("operation") != job.get("operation") or result.get("name") != job.get("name"):
                    if not isinstance(result.get("exitCode"), int):
                        raise ValueError("invalid script change request result")
            elif job["type"] == "npm.scripts.confirm":
                if result.get("status") == "success" and result.get("requestId") != job.get("requestId"):
                    raise ValueError("invalid script confirmation result")
                if result.get("status") != "success" and not isinstance(result.get("exitCode"), int):
                    raise ValueError("invalid script confirmation result")
            record["result"] = result
            record["fingerprint"] = fingerprint
            self.condition.notify_all()
            return False

    def _remember(self, identifier, record=None, error="host job is gone"):
        self.gone[identifier] = {
            "fingerprint": record.get("fingerprint") if record else None,
            "error": error,
            "time": time.monotonic(),
        }
        while len(self.gone) > MAX_HOST_JOBS:
            del self.gone[next(iter(self.gone))]

    def reject(self, runner_id, identifier, error):
        with self.condition:
            record = self.jobs.get(identifier)
            if not record or record.get("runnerId") != runner_id or record.get("result") is not None:
                return
            record["result"] = {
                "jobId": identifier,
                "exitCode": 1,
                "stdout": "",
                "stderr": f"Host result was rejected: {error}",
                "interrupted": True,
            }
            self.condition.notify_all()

    def wait(self, identifier, timeout=HOST_TIMEOUT):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                record = self.jobs.get(identifier)
                if record and record.get("result") is None:
                    age = time.monotonic() - self.runner.get("seen", 0) if self.runner else float("inf")
                    owner = record.get("runnerId")
                    lost_owner = bool(owner and self.runner.get("id") != owner)
                    if lost_owner or age > HOST_HEARTBEAT_TTL:
                        record["result"] = {
                            "jobId": identifier,
                            "exitCode": 1,
                            "stdout": "",
                            "stderr": "The assigned host runner disconnected before returning a result." if owner else "The host runner disconnected before accepting the job.",
                            "interrupted": True,
                        }
                if record and record.get("result") is not None:
                    result = record["result"]
                    del self.jobs[identifier]
                    if identifier in self.pending:
                        self.pending.remove(identifier)
                    self._remember(identifier, record)
                    return result
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    expired = self.jobs.pop(identifier, None)
                    if identifier in self.pending:
                        self.pending.remove(identifier)
                    self._remember(identifier, expired, f"host job expired after {timeout} seconds")
                    raise TimeoutError(f"host runner did not finish within {timeout} seconds")
                self.condition.wait(min(1, remaining))


HOST_BROKER = HostBroker()


def host_status():
    return HOST_BROKER.status()


def enqueue(job):
    HOST_BROKER.enqueue(job)


def wait_result(identifier, timeout=HOST_TIMEOUT):
    return HOST_BROKER.wait(identifier, timeout)


def record_host_result(identifier, source_name, script, result, detached):
    stdout, stderr = str(result.get("stdout", "")), str(result.get("stderr", ""))
    log_output(identifier, "npm.stdout", stdout)
    log_output(identifier, "npm.stderr", stderr)
    log_event("npm.complete", runId=identifier, source=source_name, script=script, detached=detached, executor="host", exitCode=result.get("exitCode"), hostPlatform=result.get("hostPlatform"), hostName=result.get("hostName"), stdoutTruncated=bool(result.get("stdoutTruncated")), stderrTruncated=bool(result.get("stderrTruncated")))


def wait_detached(identifier, source_name, script):
    try:
        record_host_result(identifier, source_name, script, wait_result(identifier), True)
    except Exception as error:
        log_event("npm.error", runId=identifier, source=source_name, script=script, detached=True, error=str(error))


def valid_command(command):
    return (isinstance(command, list) and 0 < len(command) <= MAX_COMMAND_PARTS
            and all(isinstance(part, str) and "\0" not in part for part in command)
            and sum(len(part.encode()) for part in command) <= MAX_COMMAND_BYTES)


class Handler(BaseHTTPRequestHandler):
    server_version = "nestbox-control/0.5"

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
                self.send_json(200, {"ok": True, "dockerSocketAccess": True, "workspacePackageJson": os.path.isfile(os.path.join(WORKSPACE_PATH, "package.json")), "hostRunner": host_status()})
            except Exception as error:
                self.send_json(503, {"ok": False, "dockerSocketAccess": False, "error": str(error), "hostRunner": host_status()})
            return
        if path == "/npm/scripts":
            source = self.caller()
            if not allows_npm(source):
                self.send_json(403, {"error": "caller is not allowed to use npm"})
                return
            try:
                scripts = package_scripts()
            except Exception as error:
                self.send_json(400, {"error": str(error)})
                return
            self.send_json(200, {"scripts": scripts}) if scripts is not None else self.send_json(404, {"error": "package.json was not found at /workspace/package.json"})
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
        elif path == "/npm/run":
            self.npm_run(body)
        elif path == "/npm/scripts/request":
            self.script_request(body)
        elif path == "/npm/scripts/confirm":
            self.script_confirm(body)
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

    def npm_context(self):
        source = self.caller()
        if not allows_npm(source):
            self.send_json(403, {"error": "caller is not allowed to use npm"})
            return None
        if not host_status().get("available"):
            self.send_json(503, {"error": "host runner is unavailable; run `npm run host --` from the workspace"})
            return None
        return source

    def npm_run(self, body):
        source = self.npm_context()
        if source is None: return
        script, args = body.get("script"), body.get("args", [])
        if not isinstance(script, str) or not re.fullmatch(r"[A-Za-z0-9:_@./ -]{1,128}", script) or script == "host":
            self.send_json(400, {"error": "invalid or protected script name"}); return
        if not isinstance(args, list) or not all(isinstance(arg, str) and "\0" not in arg for arg in args):
            self.send_json(400, {"error": "args must be a string array"}); return
        try:
            scripts = package_scripts()
        except Exception as error:
            self.send_json(400, {"error": str(error)}); return
        if scripts is None or script not in scripts:
            self.send_json(404, {"error": "script is not defined in /workspace/package.json"}); return
        identifier = run_id("npm")
        job = {"schemaVersion": 1, "jobId": identifier, "type": "npm.run", "script": script, "args": args, "source": service(source), "createdAt": now_iso()}
        try:
            enqueue(job)
            if body.get("detach"):
                threading.Thread(target=wait_detached, args=(identifier, service(source), script), daemon=True).start()
                self.send_json(202, {"runId": identifier, "detached": True, "executor": "host"}); return
            result = wait_result(identifier)
            record_host_result(identifier, service(source), script, result, False)
            self.send_json(200, {"runId": identifier, "exitCode": result.get("exitCode"), "stdout": str(result.get("stdout", "")), "stderr": str(result.get("stderr", "")), "pid": result.get("pid"), "executor": "host"})
        except Exception as error:
            self.send_json(502, {"error": str(error)})

    def script_request(self, body):
        source = self.npm_context()
        if source is None: return
        operation, name, command = body.get("operation"), body.get("name"), body.get("command")
        if operation not in {"add", "edit", "delete"} or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9:_@./ -]{1,128}", name) or name == "host":
            self.send_json(400, {"error": "invalid script change"}); return
        if operation != "delete" and (not isinstance(command, str) or not command.strip() or len(command) > 8192):
            self.send_json(400, {"error": "command must be a non-empty string of at most 8192 characters"}); return
        if operation == "delete" and command is not None:
            self.send_json(400, {"error": "delete does not accept a command"}); return
        identifier = run_id("npm-script-request")
        job = {"schemaVersion": 1, "jobId": identifier, "type": "npm.scripts.request", "requestId": identifier, "operation": operation, "name": name, "source": service(source), "createdAt": now_iso()}
        if operation != "delete": job["command"] = command
        try:
            enqueue(job)
            result = wait_result(identifier)
            if result.get("status") != "confirmation_required": raise ValueError(result.get("stderr", "host runner rejected the request"))
            self.send_json(202, {"status": "confirmation_required", "requestId": result.get("requestId"), "operation": operation, "name": name, "expiresAt": result.get("expiresAt")})
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def script_confirm(self, body):
        source = self.npm_context()
        if source is None: return
        request_id, code = body.get("requestId"), body.get("code")
        if not isinstance(request_id, str) or not re.fullmatch(r"npm-script-request-[A-Za-z0-9-]{16,80}", request_id) or not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{4,32}", code):
            self.send_json(400, {"error": "invalid request ID or confirmation code"}); return
        identifier = run_id("npm-script-confirm")
        job = {"schemaVersion": 1, "jobId": identifier, "type": "npm.scripts.confirm", "requestId": request_id, "code": code, "source": service(source), "createdAt": now_iso()}
        try:
            enqueue(job)
            result = wait_result(identifier)
            if result.get("status") != "success": raise ValueError(result.get("stderr", "host runner rejected the confirmation"))
            self.send_json(200, {"status": "success", "requestId": request_id, "operation": result.get("operation"), "name": result.get("name")})
        except Exception as error:
            self.send_json(400, {"error": str(error)})


class HostHandler(BaseHTTPRequestHandler):
    server_version = "nestbox-host-control/0.5"

    def setup(self):
        super().setup()
        self.connection.settimeout(HOST_LONG_POLL_TIMEOUT + 10)

    def log_message(self, fmt, *args):
        log_event("host.http.access", client=self.address_string(), message=fmt % args)

    def send_json(self, status, value):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def runner(self):
        return self.headers.get("X-Nestbox-Runner-Id", "")

    def session(self):
        return self.headers.get("X-Nestbox-Session-Id", "")

    def body(self):
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("transfer encoding is not supported")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_HOST_BODY_BYTES:
            raise ValueError("request body is too large")
        value = json.loads(self.rfile.read(length)) if length else {}
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def active_session(self):
        try:
            HOST_BROKER.touch(self.runner(), self.session())
            return True
        except PermissionError as error:
            self.send_json(409, {"error": str(error)})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        return False

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/host/health":
            if not self.active_session(): return
            self.send_json(200, {"ok": True, "hostRunner": host_status()})
            return
        if parsed.path == "/host/jobs/next":
            try:
                requested = int((parse_qs(parsed.query).get("timeout") or [HOST_LONG_POLL_TIMEOUT])[0])
                timeout = max(1, min(HOST_LONG_POLL_TIMEOUT, requested))
                job = HOST_BROKER.next(self.runner(), self.session(), timeout)
                if job is None:
                    self.send_response(204); self.end_headers(); return
                self.send_json(200, job)
            except PermissionError as error:
                self.send_json(409, {"error": str(error)})
            except (TypeError, ValueError) as error:
                self.send_json(400, {"error": str(error)})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/host/connect":
            try:
                HOST_BROKER.connect(self.runner(), self.session(), self.body())
                self.send_json(200, {"ok": True})
            except PermissionError as error:
                self.send_json(409, {"error": str(error)})
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            return
        if not self.active_session(): return
        if path == "/host/heartbeat":
            self.send_json(200, {"ok": True})
            return
        match = re.fullmatch(r"/host/jobs/([A-Za-z0-9._:-]{1,128})/result", path)
        if not match:
            self.send_json(404, {"error": "not found"}); return
        try:
            result = self.body()
            duplicate = HOST_BROKER.complete(self.runner(), self.session(), match.group(1), result)
            self.send_json(202, {"accepted": True, "duplicate": duplicate})
        except FileNotFoundError as error:
            self.send_json(410, {"error": str(error), "jobId": match.group(1)})
        except PermissionError as error:
            self.send_json(409, {"error": str(error)})
        except RuntimeError as error:
            self.send_json(409, {"error": str(error)})
        except ValueError as error:
            HOST_BROKER.reject(self.runner(), match.group(1), str(error))
            self.send_json(400, {"error": str(error)})


def main():
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", PROJECT_NAME):
        raise SystemExit("COMPOSE_PROJECT_NAME must be a non-empty lowercase project slug")
    host_server = ThreadingHTTPServer(("127.0.0.1", 4089), HostHandler)
    threading.Thread(target=host_server.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("NESTBOX_CONTROL_PORT", "4088"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
