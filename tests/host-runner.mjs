import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = await mkdtemp(join(tmpdir(), 'nestbox-host-runner-'));
const tokenFixture = await mkdtemp(join(tmpdir(), 'nestbox-host-token-'));
const testDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(testDirectory, '..', 'host-runner.mjs');
const token = 'test-token-'.padEnd(64, 'x');
const jobs = [];
const results = new Map();
const resultAttempts = new Map();
let runner;
let runnerStdout = '';
let heartbeatConflicts = 1;

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}` || !request.headers['x-nestbox-runner-id']) {
    response.writeHead(401).end('{"error":"unauthorized"}'); return;
  }
  if (request.method === 'POST' && request.url === '/_nestbox/host/heartbeat') {
    if (heartbeatConflicts > 0) { heartbeatConflicts -= 1; response.writeHead(409).end('{"error":"another host runner is active"}'); return; }
    await readBody(request); response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return;
  }
  if (request.method === 'GET' && request.url.startsWith('/_nestbox/host/jobs/next')) {
    const job = jobs.shift();
    if (!job) { response.writeHead(204).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job)); return;
  }
  const match = request.url.match(/^\/_nestbox\/host\/jobs\/([^/]+)\/result$/);
  if (request.method === 'POST' && match) {
    const jobId = decodeURIComponent(match[1]);
    const result = await readBody(request);
    const attempt = (resultAttempts.get(jobId) || 0) + 1;
    resultAttempts.set(jobId, attempt);
    if (jobId === 'job-retry' && attempt === 1) { response.writeHead(503).end('{"error":"restarting"}'); return; }
    results.set(jobId, result);
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}'); return;
  }
  response.writeHead(404).end();
});

async function waitForResult(jobId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (results.has(jobId)) return results.get(jobId);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for result ${jobId}`);
}

async function waitForEvent(type, requestId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const line of runnerStdout.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === type && (!requestId || event.requestId === requestId)) return event;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for event ${type}`);
}

function submit(job) { jobs.push({ schemaVersion: 1, ...job }); return waitForResult(job.jobId); }

try {
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      host: 'node host-runner.mjs',
      ok: `node -e "process.stdout.write('host-ok')"`,
      fail: `node -e "process.stderr.write('host-failed'); process.exit(7)"`,
    },
  }));
  const tokenPath = join(tokenFixture, 'host-token');
  await writeFile(tokenPath, `${token}\n`);
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  runner = spawn(process.execPath, [runnerPath, '--json'], {
    env: { ...process.env, npm_execpath: '', NESTBOX_HOST_WORKSPACE: fixture, NESTBOX_CONTROL_HOST_URL: `http://127.0.0.1:${port}/_nestbox`, NESTBOX_HOST_TOKEN_FILE: tokenPath, NESTBOX_HOST_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let runnerStderr = '';
  runner.stdout.on('data', chunk => runnerStdout += chunk); runner.stderr.on('data', chunk => runnerStderr += chunk);
  await waitForEvent('runner.ready');

  const success = await submit({ jobId: 'job-ok', type: 'npm.run', script: 'ok', args: [] });
  const failure = await submit({ jobId: 'job-fail', type: 'npm.run', script: 'fail', args: [] });
  if (success.exitCode !== 0 || !success.stdout.includes('host-ok') || !success.hostPlatform) throw new Error('Successful host result was not preserved.');
  if (failure.exitCode !== 7 || !failure.stderr.includes('host-failed')) throw new Error('Failed host result was not preserved.');
  const retried = await submit({ jobId: 'job-retry', type: 'npm.run', script: 'ok', args: [] });
  if (retried.exitCode !== 0 || resultAttempts.get('job-retry') !== 2) throw new Error('Host result was not retried after a transient control failure.');

  const requestId = 'npm-script-request-test-add';
  const requestedPromise = submit({ jobId: requestId, type: 'npm.scripts.request', requestId, operation: 'add', name: 'approved', command: `node -e "process.stdout.write('approved')"` });
  const event = await waitForEvent('npm.scripts.confirmation_required', requestId);
  const requested = await requestedPromise;
  if (requested.status !== 'confirmation_required' || Object.hasOwn(requested, 'code')) throw new Error('Script request exposed its confirmation code.');
  const confirmed = await submit({ jobId: 'confirm-add', type: 'npm.scripts.confirm', requestId, code: event.code });
  const changed = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  if (confirmed.status !== 'success' || !changed.scripts.approved) throw new Error('Approved script was not added.');

  const protectedResult = await submit({ jobId: 'protected-host', type: 'npm.scripts.request', requestId: 'protected-host', operation: 'delete', name: 'host' });
  if (protectedResult.exitCode !== 1 || !protectedResult.stderr.includes('cannot be changed')) throw new Error('Core host script was not protected.');

  const exit = new Promise((resolveExit, reject) => { runner.on('error', reject); runner.on('close', code => code === 0 || code === null ? resolveExit() : reject(new Error(`Runner exited ${code}: ${runnerStderr}`))); });
  runner.kill('SIGTERM'); await exit; runner = undefined;

  const onceRunner = spawn(process.execPath, [runnerPath, '--once', '--json'], {
    env: { ...process.env, npm_execpath: '', NESTBOX_HOST_WORKSPACE: fixture, NESTBOX_CONTROL_HOST_URL: `http://127.0.0.1:${port}/_nestbox`, NESTBOX_HOST_TOKEN_FILE: tokenPath, NESTBOX_HOST_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const onceExit = await Promise.race([
    new Promise(resolveExit => onceRunner.once('close', resolveExit)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('--once runner did not exit after an empty poll.')), 5000)),
  ]);
  if (onceExit !== 0) throw new Error(`--once runner exited ${onceExit}.`);

  const unsafeToken = join(fixture, 'unsafe-token');
  await writeFile(unsafeToken, `${token}\n`);
  const unsafe = spawnSync(process.execPath, [runnerPath, '--once'], {
    env: { ...process.env, NESTBOX_HOST_WORKSPACE: fixture, NESTBOX_CONTROL_HOST_URL: `http://127.0.0.1:${port}/_nestbox`, NESTBOX_HOST_TOKEN_FILE: unsafeToken, NESTBOX_HOST_TOKEN: '' }, encoding: 'utf8', windowsHide: true,
  });
  if (unsafe.status === 0 || !unsafe.stderr.includes('must be outside')) throw new Error('Runner accepted a token inside the workspace.');
  console.log('Host runner HTTP tests passed.');
} finally {
  runner?.kill('SIGTERM');
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(fixture, { recursive: true, force: true });
  await rm(tokenFixture, { recursive: true, force: true });
}
