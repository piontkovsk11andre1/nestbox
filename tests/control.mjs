import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const server = resolve('docker/control/server.py');
const bridge = resolve('docker/control/host_bridge.py');
const policyTest = String.raw`
import importlib.util
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
broker = control.HostBroker()
metadata = {"pid": 123, "platform": "test", "hostname": "host"}
broker.connect("runner-test-1234", "session-test-1234", metadata)
assert broker.status()["available"]
job = {"jobId": "job-test", "type": "npm.run"}
broker.enqueue(job)
assert broker.next("runner-test-1234", "session-test-1234", 1) == job
# A new exec session for the same stable runner recovers the assignment and supersedes the old helper.
broker.connect("runner-test-1234", "session-test-5678", metadata)
assert broker.next("runner-test-1234", "session-test-5678", 1) == job
try:
    broker.touch("runner-test-1234", "session-test-1234")
    raise AssertionError("stale session was accepted")
except PermissionError:
    pass
result = {"jobId": "job-test", "exitCode": 0, "stdout": "", "stderr": ""}
assert broker.complete("runner-test-1234", "session-test-5678", "job-test", result) is False
assert broker.complete("runner-test-1234", "session-test-5678", "job-test", result) is True
try:
    broker.complete("runner-test-1234", "session-test-5678", "job-test", {**result, "stdout": "different"})
    raise AssertionError("conflicting replay was accepted")
except RuntimeError:
    pass
assert broker.wait("job-test", 1)["exitCode"] == 0
assert broker.complete("runner-test-1234", "session-test-5678", "job-test", result) is True
try:
    broker.complete("runner-test-1234", "session-test-5678", "job-missing", {"jobId": "job-missing", "exitCode": 0, "stdout": "", "stderr": ""})
    raise AssertionError("missing job result was accepted")
except FileNotFoundError:
    pass
original_ttl = control.HOST_HEARTBEAT_TTL
control.HOST_HEARTBEAT_TTL = 0
stale_assigned = control.HostBroker()
stale_assigned.connect("runner-stale-1234", "session-stale-1234", metadata)
stale_assigned.enqueue({"jobId": "job-stale-assigned", "type": "npm.run"})
assert stale_assigned.next("runner-stale-1234", "session-stale-1234", 1)["jobId"] == "job-stale-assigned"
assert stale_assigned.wait("job-stale-assigned", 1)["interrupted"] is True
stale_pending = control.HostBroker()
stale_pending.connect("runner-pending-1234", "session-pending-1234", metadata)
stale_pending.enqueue({"jobId": "job-stale-pending", "type": "npm.run"})
assert stale_pending.wait("job-stale-pending", 1)["interrupted"] is True
control.HOST_HEARTBEAT_TTL = original_ttl
expired = control.HostBroker()
expired.connect("runner-expired-1234", "session-expired-1234", metadata)
expired.enqueue({"jobId": "job-expired", "type": "npm.run"})
assert expired.next("runner-expired-1234", "session-expired-1234", 1)["jobId"] == "job-expired"
try:
    expired.wait("job-expired", 0)
    raise AssertionError("expired job returned")
except TimeoutError:
    pass
try:
    expired.complete("runner-expired-1234", "session-expired-1234", "job-expired", {"jobId": "job-expired", "exitCode": 0, "stdout": "", "stderr": ""})
    raise AssertionError("expired result was accepted")
except FileNotFoundError:
    pass
bridge_spec = importlib.util.spec_from_file_location("host_bridge", r"${bridge}")
host_bridge = importlib.util.module_from_spec(bridge_spec)
bridge_spec.loader.exec_module(host_bridge)
sent = []
host_bridge.send = sent.append
host_bridge.request = lambda *args, **kwargs: (409, {"error": "conflicting host result replay"})
host_bridge.deliver_result("runner-test", "session-test", {"jobId": "job-conflict"})
assert sent[-1]["type"] == "result.rejected"
host_bridge.request = lambda *args, **kwargs: (400, {"error": "invalid npm run result"})
host_bridge.deliver_result("runner-test", "session-test", {"jobId": "job-invalid"})
assert sent[-1]["type"] == "result.rejected"
host_bridge.request = lambda *args, **kwargs: (410, {"error": "host job expired"})
host_bridge.deliver_result("runner-test", "session-test", {"jobId": "job-gone"})
assert sent[-1]["type"] == "gone"
host_bridge.request = lambda *args, **kwargs: (409, {"error": "host runner session was superseded"})
try:
    host_bridge.deliver_result("runner-test", "session-test", {"jobId": "job-session"})
    raise AssertionError("superseded session was treated as terminal")
except RuntimeError:
    pass
`;

let result = spawnSync(python, ['-c', policyTest], {
  encoding: 'utf8',
  env: { ...process.env, COMPOSE_PROJECT_NAME: 'nestbox-test', PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.status !== 0) throw new Error(`Control policy test failed: ${result.stderr || result.stdout}`);

result = spawnSync(python, [bridge], { input: '', encoding: 'utf8', timeout: 2000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (result.status !== 0 || result.error?.code === 'ETIMEDOUT') throw new Error(`Host bridge did not close cleanly on stdin EOF: ${result.error?.message || result.stderr}`);

result = spawnSync(python, [server], { encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: '', PYTHONDONTWRITEBYTECODE: '1' } });
if (result.status === 0 || !result.stderr.includes('COMPOSE_PROJECT_NAME')) throw new Error('Control did not fail closed without a project name.');

const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
].map(value => JSON.stringify(value)).join('\n') + '\n';
result = spawnSync(process.execPath, [resolve('home/configs/opencode/control-mcp.js')], { input: messages, encoding: 'utf8' });
if (result.status !== 0) throw new Error(`Control MCP test failed: ${result.stderr}`);
const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
const names = responses.find(value => value.id === 2)?.result?.tools?.map(tool => tool.name) || [];
for (const name of ['docker_exec', 'npm_scripts', 'npm_run', 'npm_script_change_request', 'npm_script_change_confirm']) {
  if (!names.includes(name)) throw new Error(`Control MCP does not expose ${name}.`);
}

console.log('Control tests passed.');
