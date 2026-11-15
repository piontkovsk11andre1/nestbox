import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const server = resolve('docker/control/server.py');
const policyTest = String.raw`
import importlib.util
import http.client
import json
import threading
from http.server import ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("control", r"${server}")
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
assert control.is_root_user("root")
assert control.is_root_user("root:root")
assert control.is_root_user("0:0")
assert control.is_root_user("00:0")
assert control.is_root_user("+0")
assert not control.is_root_user("1000:1000")
source = {"Labels": {"com.docker.compose.service": "opencode", "nestbox.exec.allow-source": "true", "nestbox.exec.targets": "php-fpm"}}
target = {"Id": "abc", "Names": ["/project-php-fpm-1"], "Labels": {"com.docker.compose.service": "php-fpm", "nestbox.exec.allow-target": "true"}}
assert control.policy_error(source, target, "1000") == ""
assert "root" in control.policy_error(source, target, "0:0")
assert "named user" in control.policy_error(source, target, "root-alias", "nestbox")
target["Labels"]["nestbox.exec.allow-root"] = "true"
assert control.policy_error(source, target, "root:root") == ""
target["Labels"]["com.docker.compose.service"] = "rollup"
assert "not allowed" in control.policy_error(source, target, "1000")
source["Labels"].pop("nestbox.exec.targets")
assert "no allowed" in control.policy_error(source, target, "1000")
source["Labels"]["nestbox.exec.targets"] = "php-fpm"
target["Labels"]["com.docker.compose.service"] = "php-fpm"
target["Labels"].pop("nestbox.exec.allow-root")

# Exercise the public control contract without requiring a real Docker socket.
calls = []
def docker_request(method, path, body=None, max_bytes=None):
    calls.append((method, path, body))
    if path == "/_ping": return b"OK"
    if path == "/containers/abc/json": return {"Config": {"User": "1000:1000"}}
    if path == "/containers/abc/exec": return {"Id": "exec-test"}
    if path == "/exec/exec-test/start": return (b"hello\n", 6)
    if path == "/exec/exec-test/json": return {"ExitCode": 0}
    raise AssertionError(path)
control.docker_request = docker_request
control.find_by_ip = lambda ip: source
control.find_by_name = lambda name: target if name == "php-fpm" else None
httpd = ThreadingHTTPServer(("127.0.0.1", 0), control.Handler)
thread = threading.Thread(target=httpd.serve_forever, daemon=True)
thread.start()
def request(method, path, body=None):
    connection = http.client.HTTPConnection(*httpd.server_address, timeout=5)
    try:
        connection.request(method, path, json.dumps(body) if body is not None else None)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()
try:
    status, health = request("GET", "/health")
    assert status == 200 and health == {"ok": True, "dockerSocketAccess": True}
    for method, path in [("GET", "/npm/scripts"), ("POST", "/npm/run"), ("POST", "/npm/scripts/request"), ("POST", "/npm/scripts/confirm"), ("POST", "/host/connect"), ("GET", "/host/jobs/next")]:
        assert request(method, path, {} if method == "POST" else None)[0] == 404
    body = {"workdir": "/workspace", "command": ["php", "--version"]}
    status, result = request("POST", "/containers/php-fpm/exec", body)
    assert status == 200 and result["exitCode"] == 0 and result["output"] == "hello\n"
    assert result["outputTotalBytes"] == 6 and result["outputTruncated"] is False
    created = next(call[2] for call in calls if call[1] == "/containers/abc/exec")
    assert created["Cmd"] == body["command"] and created["WorkingDir"] == "/workspace"
    calls.clear()
    assert request("POST", "/containers/php-fpm/exec", {**body, "user": "0"})[0] == 403
    assert not any(path.endswith("/exec") for _, path, _ in calls)
    assert request("POST", "/containers/php-fpm/exec", {**body, "command": "php --version"})[0] == 400
    assert request("POST", "/containers/php-fpm/exec", {**body, "workdir": "relative"})[0] == 400
finally:
    httpd.shutdown()
    httpd.server_close()
    thread.join()
`;

let result = spawnSync(python, ['-c', policyTest], {
  encoding: 'utf8',
  env: { ...process.env, COMPOSE_PROJECT_NAME: 'nestbox-test', PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.status !== 0) throw new Error(`Control policy/API test failed: ${result.error?.message || result.stderr || result.stdout}`);

result = spawnSync(python, [server], { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: '', PYTHONDONTWRITEBYTECODE: '1' } });
if (result.status === 0 || !result.stderr.includes('COMPOSE_PROJECT_NAME')) throw new Error('Control did not fail closed without a project name.');

const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'npm_run', arguments: { script: 'build' } } },
].map(value => JSON.stringify(value)).join('\n') + '\n';
result = spawnSync(process.execPath, [resolve('home/configs/opencode/control-mcp.js')], { input: messages, encoding: 'utf8' });
if (result.status !== 0) throw new Error(`Control MCP test failed: ${result.stderr}`);
const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
const names = responses.find(value => value.id === 2)?.result?.tools?.map(tool => tool.name) || [];
if (names.length !== 1 || names[0] !== 'docker_exec') throw new Error('Control MCP must expose only docker_exec.');
if (!responses.find(value => value.id === 3)?.error?.message.includes('Unknown tool')) throw new Error('Control MCP accepted a removed host tool.');

console.log('Control tests passed.');
