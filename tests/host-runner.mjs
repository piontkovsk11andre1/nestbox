import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = await mkdtemp(join(tmpdir(), 'nestbox-host-runner-'));
const testDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(testDirectory, '..', 'host-runner.mjs');
const queue = `${fixture}-queue`;
const requests = join(queue, 'requests');
const running = join(queue, 'running');
const results = join(queue, 'results');
let runner;
let stdout = '';

async function waitFor(path, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForEvent(type, requestId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === type && (!requestId || event.requestId === requestId)) return event;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function submit(job) {
  await writeFile(join(requests, `${job.jobId}.json`), JSON.stringify({ schemaVersion: 1, ...job }));
  return JSON.parse(await waitFor(join(results, `${job.jobId}.json`)));
}

try {
  await Promise.all([mkdir(requests, { recursive: true }), mkdir(running, { recursive: true })]);
  await writeFile(join(running, 'interrupted-job.json'), JSON.stringify({ schemaVersion: 1, jobId: 'interrupted-job', type: 'npm.run', script: 'ok', args: [] }));
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      host: 'node host-runner.mjs',
      ok: `node -e "process.stdout.write('host-ok')"`,
      fail: `node -e "process.stderr.write('host-failed'); process.exit(7)"`,
    },
  }));
  runner = spawn(process.execPath, [runnerPath, '--json'], {
    env: { ...process.env, NESTBOX_HOST_WORKSPACE: fixture, NESTBOX_HOST_QUEUE: queue },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  runner.stdout.on('data', chunk => stdout += chunk);
  runner.stderr.on('data', chunk => stderr += chunk);
  await waitFor(join(queue, 'heartbeat.json'));
  const interrupted = JSON.parse(await waitFor(join(results, 'interrupted-job.json')));
  if (!interrupted.interrupted || interrupted.exitCode !== 1) throw new Error('Interrupted job was replayed instead of rejected.');

  const success = await submit({ jobId: 'job-ok', type: 'npm.run', script: 'ok', args: [] });
  const failure = await submit({ jobId: 'job-fail', type: 'npm.run', script: 'fail', args: [] });
  if (success.exitCode !== 0 || !success.stdout.includes('host-ok') || !success.hostPlatform) throw new Error('Successful host result was not preserved.');
  if (failure.exitCode !== 7 || !failure.stderr.includes('host-failed')) throw new Error('Failed host result was not preserved.');

  const requestId = 'npm-script-request-test-add';
  const requested = await submit({ jobId: requestId, type: 'npm.scripts.request', requestId, operation: 'add', name: 'approved', command: `node -e "process.stdout.write('approved')"` });
  const event = await waitForEvent('npm.scripts.confirmation_required', requestId);
  if (requested.status !== 'confirmation_required' || Object.hasOwn(requested, 'code')) throw new Error('Script request exposed its confirmation code.');
  const confirmed = await submit({ jobId: 'confirm-add', type: 'npm.scripts.confirm', requestId, code: event.code });
  const changed = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  if (confirmed.status !== 'success' || !changed.scripts.approved) throw new Error('Approved script was not added.');

  const raceId = 'npm-script-request-race-test';
  await submit({ jobId: raceId, type: 'npm.scripts.request', requestId: raceId, operation: 'edit', name: 'approved', command: 'node changed.mjs' });
  const raceEvent = await waitForEvent('npm.scripts.confirmation_required', raceId);
  changed.scripts.concurrent = 'node concurrent.mjs';
  await writeFile(join(fixture, 'package.json'), JSON.stringify(changed));
  const raced = await submit({ jobId: 'confirm-race', type: 'npm.scripts.confirm', requestId: raceId, code: raceEvent.code });
  if (raced.exitCode !== 1 || !raced.stderr.includes('changed after approval')) throw new Error('Concurrent package change was overwritten.');

  const protectedResult = await submit({ jobId: 'protected-host', type: 'npm.scripts.request', requestId: 'protected-host', operation: 'delete', name: 'host' });
  if (protectedResult.exitCode !== 1 || !protectedResult.stderr.includes('cannot be changed')) throw new Error('Core host script was not protected.');

  const exit = new Promise((resolveExit, reject) => {
    runner.on('error', reject);
    runner.on('close', code => code === 0 || code === null ? resolveExit() : reject(new Error(`Runner exited ${code}: ${stderr}`)));
  });
  runner.kill('SIGTERM');
  await exit;
  runner = undefined;
  console.log('Host runner tests passed.');
} finally {
  runner?.kill('SIGTERM');
  await rm(fixture, { recursive: true, force: true });
  await rm(queue, { recursive: true, force: true });
}
