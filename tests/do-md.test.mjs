import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createDoMdServer } from '@p10i/do-md/sources/HttpServer.mjs';

const require = createRequire(import.meta.url);
const dependencyRequire = createRequire(require.resolve('@p10i/do-md/package.json'));
const { parse } = dependencyRequire('yaml');
const functions = resolve('home/code/__includes/functions.php');

function run(command, args, env = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env: { ...process.env, NESTBOX_TEST_FUNCTIONS: functions, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} failed (${code ?? signal}): ${stderr || stdout}`));
      else done(stdout);
    });
  });
}

test('default service, shared aliases, and remote MCP form one consistent contract', async () => {
  const compose = parse(await readFile('docker-compose.yaml', 'utf8'));
  assert.deepEqual(Object.keys(compose.services).sort(), ['control', 'do-md', 'nginx', 'opencode', 'php-fpm', 'rollup']);
  const backend = compose.services['do-md'];
  assert.equal(backend.ports, undefined);
  assert.equal(backend.env_file, undefined);
  assert.equal(backend.user, '${APP_UID:-1000}:${APP_GID:-1000}');
  assert.ok(backend.command.includes('/documents'));
  for (const name of ['do-md', 'php-fpm', 'opencode']) {
    const mounts = compose.services[name].volumes;
    for (const [target, source] of [['/documents/workspace', '${WORKSPACE_PATH:-.}'], ['/documents/pages', '${NESTBOX_PAGE_PATH:-./home/code}']]) {
      const mount = mounts.find(mount => mount.target === target);
      assert.equal(mount.source, source, `${name} ${target}`);
      assert.equal(mount.bind.create_host_path, false);
      assert.notEqual(mount.read_only, true);
    }
  }
  for (const name of ['opencode', 'php-fpm']) {
    assert.equal(compose.services[name].depends_on['do-md'].condition, 'service_healthy');
    assert.ok(compose.services[name].environment.includes('NESTBOX_DO_MD_URL=http://do-md:8080'));
  }
  const config = JSON.parse(await readFile('home/configs/opencode/opencode.json', 'utf8'));
  assert.equal(config.mcp['do-md'].type, 'local');
  assert.deepEqual(config.mcp['do-md'].command, ['do-md-mcp', '--url', '{env:NESTBOX_DO_MD_URL}', '--root', '/documents', '--timeout-ms', '{env:NESTBOX_DO_MD_TIMEOUT_MS}']);
  assert.equal(config.permission.external_directory['/documents/**'], 'allow');
  for (const file of ['docker/do-md/Dockerfile', 'docker/opencode/Dockerfile']) {
    const dockerfile = await readFile(file, 'utf8');
    assert.match(dockerfile, /@p10i\/do-md@latest/);
    assert.match(dockerfile, /node \/opt\/do-md\/check\.mjs --package/);
  }
});

test('PHP helpers and image MCP proxy execute against the published do-md service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nestbox-do-md-'));
  let server;
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'pages'));
    server = await createDoMdServer({ root, port: 0, timeoutMs: 20000 }).start();
    const env = { NESTBOX_DO_MD_URL: `http://127.0.0.1:${server.port}`, NESTBOX_DO_MD_TIMEOUT_MS: '20000', NESTBOX_DO_MD_TEST_DOCUMENTS: root };
    assert.match(await run(process.env.PHP || 'php', [resolve('tests/do-md-smoke.php')], env), /PHP helpers, ownership, and both shared mounts verified/);
    assert.match(await run(process.execPath, [resolve('docker/do-md/check.mjs'), '--mcp'], env), /remote MCP and both shared mounts verified/);
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});

test('PHP transport preserves HTTP diagnostics, rejects invalid responses, and never retries', async () => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = body ? JSON.parse(body).params : {};
    const mode = params.file;
    calls.push(mode ?? request.url);
    if (mode === 'disconnect') { request.socket.destroy(); return; }
    const error = { code: 'DO_MD_PARSE_ERROR', message: 'fixture mismatch', file: 'domain', line: 1, column: 1, snippet: null };
    let status = mode === 'busy' ? 503 : mode === 'deadline' ? 504 : mode === 'redirect' ? 302 : 200;
    let result = { apiVersion: 1, ok: false, exitCode: 2, output: null, context: null, errors: [error] };
    if (mode === 'version') result.apiVersion = 2;
    if (mode === 'shape') result.exitCode = '2';
    if (mode === 'bad-output') result = { apiVersion: 1, ok: true, exitCode: 0, errors: [], output: null, wrote: null };
    response.writeHead(status, { 'content-type': mode === 'html' ? 'text/html' : 'application/json', ...(mode === 'redirect' ? { location: '/must-not-follow' } : {}) });
    response.end(mode === 'json' ? '{' : mode === 'large' ? 'x'.repeat(8388609) : JSON.stringify(result));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const code = String.raw`
require getenv('NESTBOX_TEST_FUNCTIONS');
foreach (['domain', 'busy', 'deadline'] as $mode) {
    $result = nestbox_do_md_validate(['file' => $mode, 'template' => 'fixture'], '/documents/workspace');
    if ($result['ok'] || $result['errors'][0]['code'] !== 'DO_MD_PARSE_ERROR') throw new RuntimeException('Lost domain diagnostics');
}
foreach (['version', 'shape', 'html', 'json', 'large', 'redirect', 'disconnect'] as $mode) {
    $thrown = false;
    try { nestbox_do_md_validate(['file' => $mode, 'template' => 'fixture'], '/documents/workspace'); }
    catch (RuntimeException|UnexpectedValueException $error) { $thrown = true; }
    if (!$thrown) throw new RuntimeException('Accepted invalid response: ' . $mode);
}
$thrown = false;
try { nestbox_do_md_create(['file' => 'bad-output', 'template' => 'fixture', 'data' => []], '/documents/workspace'); }
catch (UnexpectedValueException $error) { $thrown = true; }
if (!$thrown) throw new RuntimeException('Accepted malformed output');
foreach (['command', 'directory', 'params', 'limits', 'body', 'path', 'configuration'] as $mode) {
    $thrown = false;
    try {
        match ($mode) {
            'command' => nestbox_do_md('shell'),
            'directory' => nestbox_do_md('reference', [], 'relative'),
            'params' => nestbox_do_md_create(['data' => ['a', 'b']]),
            'limits' => nestbox_do_md_reference([], '/documents', ['timeoutMs' => 0]),
            'body' => nestbox_do_md_create(['data' => ['large' => str_repeat('x', 1048577)]]),
            'path' => nestbox_do_md_request('POST', "/v1/commands/validate\n", []),
            'configuration' => (function () { putenv('NESTBOX_DO_MD_TIMEOUT_MS=invalid'); nestbox_do_md_reference(); })(),
        };
    } catch (InvalidArgumentException|UnexpectedValueException $error) { $thrown = true; }
    if (!$thrown) throw new RuntimeException('Accepted invalid input: ' . $mode);
}
echo 'transport verified';
`;
    const output = await run(process.env.PHP || 'php', ['-r', code], { NESTBOX_DO_MD_URL: `http://127.0.0.1:${server.address().port}`, NESTBOX_DO_MD_TIMEOUT_MS: '1' });
    assert.equal(output, 'transport verified');
    assert.equal(calls.filter(mode => mode === 'disconnect').length, 1);
    assert.equal(calls.length, 11);
    assert.equal(calls.includes('/must-not-follow'), false);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
