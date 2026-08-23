import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const server = resolve('docker/control/server.py');
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
`;

let result = spawnSync(python, ['-c', policyTest], {
  encoding: 'utf8',
  env: { ...process.env, COMPOSE_PROJECT_NAME: 'nestbox-test', PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.status !== 0) throw new Error(`Control policy test failed: ${result.stderr || result.stdout}`);

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
