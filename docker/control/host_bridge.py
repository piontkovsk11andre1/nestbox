#!/usr/bin/env python3
import http.client
import json
import signal
import sys
import threading
import time
from urllib.parse import quote

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 64 * 1024 * 1024
HEARTBEAT_SECONDS = 4
stopping = threading.Event()
input_condition = threading.Condition()
input_messages = []
input_error = None
input_eof = False
connections = set()
connections_lock = threading.Lock()


def diagnostic(message):
    sys.stderr.write(f"nestbox host bridge: {message}\n")
    sys.stderr.flush()


def stop_requests():
    stopping.set()
    with connections_lock:
        active = list(connections)
    for connection in active:
        connection.close()
    with input_condition:
        input_condition.notify_all()


def send(message):
    data = json.dumps({"protocolVersion": PROTOCOL_VERSION, **message}, separators=(",", ":"))
    sys.stdout.write(data + "\n")
    sys.stdout.flush()


def read_input():
    global input_error, input_eof
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
            if not line:
                with input_condition:
                    input_eof = True
                    input_condition.notify_all()
                stop_requests()
                return
            if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                raise ValueError("protocol line exceeds the limit")
            value = json.loads(line)
            if not isinstance(value, dict) or value.get("protocolVersion") != PROTOCOL_VERSION:
                raise ValueError("unsupported protocol message")
            with input_condition:
                if len(input_messages) >= 2:
                    raise ValueError("too many queued protocol messages")
                input_messages.append(value)
                input_condition.notify_all()
    except Exception as error:
        with input_condition:
            input_error = error
            input_condition.notify_all()
        stop_requests()


def receive():
    with input_condition:
        while not input_messages and not input_eof and input_error is None and not stopping.is_set():
            input_condition.wait()
        if input_error is not None:
            raise input_error
        if not input_messages:
            raise EOFError
        return input_messages.pop(0)


def request(method, path, runner_id, session_id, body=None, timeout=35):
    payload = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    headers = {
        "X-Nestbox-Runner-Id": runner_id,
        "X-Nestbox-Session-Id": session_id,
        "Content-Type": "application/json",
    }
    connection = http.client.HTTPConnection("127.0.0.1", 4089, timeout=timeout)
    with connections_lock:
        connections.add(connection)
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read(MAX_LINE_BYTES + 1)
    finally:
        connection.close()
        with connections_lock:
            connections.discard(connection)
    if len(data) > MAX_LINE_BYTES:
        raise RuntimeError("control response exceeds the limit")
    value = json.loads(data) if data else None
    return response.status, value


def heartbeat(runner_id, session_id, metadata):
    while not stopping.wait(HEARTBEAT_SECONDS):
        try:
            status, value = request("POST", "/host/heartbeat", runner_id, session_id, metadata, timeout=5)
            if status == 409:
                diagnostic((value or {}).get("error", "session was superseded"))
                stop_requests()
                return
            if status >= 400:
                diagnostic(f"heartbeat returned HTTP {status}")
        except Exception as error:
            if not stopping.is_set():
                diagnostic(f"heartbeat failed: {error}")


def deliver_result(runner_id, session_id, result):
    job_id = result.get("jobId")
    delay = 0.5
    while not stopping.is_set():
        try:
            status, response = request("POST", f"/host/jobs/{quote(str(job_id), safe='')}/result", runner_id, session_id, result)
            if status in (200, 202):
                send({"type": "result.ack", "jobId": job_id, "duplicate": bool((response or {}).get("duplicate"))})
                return
            error = (response or {}).get("error", f"result returned HTTP {status}")
            if status == 410:
                send({"type": "gone", "jobId": job_id, "error": error})
                return
            if status == 409 and "session was superseded" in error.lower():
                raise RuntimeError(error)
            if status < 500:
                send({"type": "result.rejected", "jobId": job_id, "error": error})
                return
        except (OSError, http.client.HTTPException) as error:
            if stopping.is_set():
                raise EOFError from error
            diagnostic(f"result delivery failed: {error}; retrying")
        stopping.wait(delay)
        delay = min(10, delay * 2)


def main():
    threading.Thread(target=read_input, daemon=True).start()
    hello = receive()
    if hello.get("type") != "hello":
        raise ValueError("first protocol message must be hello")
    runner_id, session_id = hello.get("runnerId"), hello.get("sessionId")
    metadata = hello.get("metadata") or {}
    if not isinstance(runner_id, str) or not isinstance(session_id, str) or not isinstance(metadata, dict):
        raise ValueError("invalid hello message")
    status, value = request("POST", "/host/connect", runner_id, session_id, metadata)
    if status >= 400:
        raise RuntimeError(f"connect returned HTTP {status}: {(value or {}).get('error', value)}")
    thread = threading.Thread(target=heartbeat, args=(runner_id, session_id, metadata), daemon=True)
    thread.start()
    retained_result = hello.get("retainedResult")
    if retained_result is not None:
        if not isinstance(retained_result, dict):
            raise ValueError("invalid retained result")
        deliver_result(runner_id, session_id, retained_result)
        if stopping.is_set():
            return
    send({"type": "ready"})
    while not stopping.is_set():
        status, value = request("GET", "/host/jobs/next?timeout=25", runner_id, session_id, timeout=30)
        if status == 204:
            send({"type": "idle"})
            continue
        if status == 409:
            raise RuntimeError((value or {}).get("error", "session was superseded"))
        if status == 410:
            send({"type": "gone", "jobId": (value or {}).get("jobId"), "error": (value or {}).get("error", "job is gone")})
            continue
        if status >= 400 or not isinstance(value, dict):
            raise RuntimeError(f"next job returned HTTP {status}: {value}")
        send({"type": "job", "job": value})
        result = receive()
        if result.get("type") != "result" or not isinstance(result.get("result"), dict):
            raise ValueError("expected a result message")
        job_id = result["result"].get("jobId")
        if job_id != value.get("jobId"):
            raise ValueError("result does not match the assigned job")
        deliver_result(runner_id, session_id, result["result"])


def stop(_signum, _frame):
    stop_requests()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        main()
    except EOFError:
        pass
    except Exception as error:
        if not stopping.is_set():
            diagnostic(str(error))
            sys.exit(1)
