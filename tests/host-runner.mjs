import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = await mkdtemp(join(tmpdir(), 'nestbox-host-runner-'));
const testDirectory = dirname(fileURLToPath(import.meta.url));
const runnerPath = resolve(testDirectory, '..', 'host-runner.mjs');
const fakeBridge = join(fixture, 'fake-docker.mjs');
const jobPath = join(fixture, 'bridge-job.json');
const resultPath = join(fixture, 'bridge-result.json');
const invocationPath = join(fixture, 'invocations.jsonl');
const ackPath = join(fixture, 'acked-marker');
let runner;
let runnerStdout = '';

const fakeSource = String.raw`
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_INVOCATIONS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
const messages = [];
let waiter, ended = false, input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (line) messages.push(JSON.parse(line));
    if (waiter) { const resolve = waiter; waiter = null; resolve(); }
  }
});
process.stdin.on('end', () => { ended = true; if (waiter) waiter(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function receive() {
  while (!messages.length && !ended) await new Promise(resolve => waiter = resolve);
  if (!messages.length) return null;
  return messages.shift();
}
function send(value) { process.stdout.write(JSON.stringify({ protocolVersion: 1, ...value }) + '\n'); }
const hello = await receive();
if (hello?.type !== 'hello') process.exit(2);
if (hello.retainedResult) {
  if (hello.retainedResult.jobId === 'job-rejected') {
    writeFileSync(process.env.FAKE_REJECTED, 'terminal');
    send({ type: 'result.rejected', jobId: hello.retainedResult.jobId, error: 'conflicting host result replay' });
  } else {
    if (existsSync(process.env.FAKE_JOB)) unlinkSync(process.env.FAKE_JOB);
    writeFileSync(process.env.FAKE_RESULT, JSON.stringify(hello.retainedResult));
    send({ type: 'result.ack', jobId: hello.retainedResult.jobId, duplicate: true });
    await sleep(25);
    writeFileSync(process.env.FAKE_RECONCILED, hello.retainedResult.jobId);
    writeFileSync(process.env.FAKE_ACKED + '.' + hello.retainedResult.jobId, hello.retainedResult.jobId);
  }
}
send({ type: 'ready' });
while (!ended) {
  if (!existsSync(process.env.FAKE_JOB)) { send({ type: 'idle' }); await sleep(50); continue; }
  const job = JSON.parse(readFileSync(process.env.FAKE_JOB, 'utf8'));
  send({ type: 'job', job });
  if (job.jobId === 'job-inflight' && !existsSync(process.env.FAKE_INFLIGHT)) {
    writeFileSync(process.env.FAKE_INFLIGHT, 'disconnected');
    process.exit(76);
  }
  const message = await receive();
  if (!message) break;
  if (message.type !== 'result' || message.result?.jobId !== job.jobId) process.exit(3);
  if (job.jobId === 'job-retry' && !existsSync(process.env.FAKE_RETRY)) {
    writeFileSync(process.env.FAKE_RETRY, 'attempted');
    writeFileSync(process.env.FAKE_RESULT, JSON.stringify(message.result));
    unlinkSync(process.env.FAKE_JOB);
    process.exit(75);
  }
  if (job.jobId === 'job-rejected' && !existsSync(process.env.FAKE_REJECT)) {
    writeFileSync(process.env.FAKE_REJECT, 'accepted-without-ack');
    unlinkSync(process.env.FAKE_JOB);
    process.exit(77);
  }
  unlinkSync(process.env.FAKE_JOB);
  writeFileSync(process.env.FAKE_RESULT, JSON.stringify(message.result));
  send({ type: 'result.ack', jobId: job.jobId });
  await sleep(25);
  writeFileSync(process.env.FAKE_ACKED + '.' + job.jobId, job.jobId);
}
`;

async function waitFor(path, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function submit(job) {
  const jobAckPath = `${ackPath}.${job.jobId}`;
  await rm(resultPath, { force: true });
  await rm(jobAckPath, { force: true });
  await writeFile(jobPath, JSON.stringify({ schemaVersion: 1, ...job }));
  await waitFor(resultPath);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  if (job.jobId !== 'job-retry') {
    await waitFor(jobAckPath);
    if (await readFile(jobAckPath, 'utf8') !== job.jobId) throw new Error(`Unexpected acknowledgement for ${job.jobId}.`);
  }
  return result;
}

async function waitForEvent(type, requestId, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const line of runnerStdout.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === type && (!requestId || event.requestId === requestId || event.jobId === requestId)) return event;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for event ${type}`);
}

try {
  await writeFile(fakeBridge, fakeSource);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      host: 'node host-runner.mjs',
      ok: `node -e "process.stdout.write('host-ok')"`,
      fail: `node -e "process.stderr.write('host-failed'); process.exit(7)"`,
      delayed: `node -e "setTimeout(() => require('fs').appendFileSync('executions', 'x'), 300)"`,
    },
  }));
  const environment = {
    ...process.env,
    npm_execpath: '',
    NESTBOX_HOST_WORKSPACE: fixture,
    NESTBOX_HOST_DOCKER: process.execPath,
    NESTBOX_HOST_DOCKER_ARGS: JSON.stringify([fakeBridge]),
    FAKE_JOB: jobPath,
    FAKE_RESULT: resultPath,
    FAKE_RETRY: join(fixture, 'retry-marker'),
    FAKE_RECONCILED: join(fixture, 'reconciled-marker'),
    FAKE_REJECT: join(fixture, 'reject-marker'),
    FAKE_REJECTED: join(fixture, 'rejected-marker'),
    FAKE_ACKED: ackPath,
    FAKE_INFLIGHT: join(fixture, 'inflight-marker'),
    FAKE_INVOCATIONS: invocationPath,
  };
  runner = spawn(process.execPath, [runnerPath, '--json'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let runnerStderr = '';
  runner.stdout.on('data', chunk => runnerStdout += chunk); runner.stderr.on('data', chunk => runnerStderr += chunk);
  await waitForEvent('runner.ready');

  const success = await submit({ jobId: 'job-ok', type: 'npm.run', script: 'ok', args: [] });
  const failure = await submit({ jobId: 'job-fail', type: 'npm.run', script: 'fail', args: [] });
  if (success.exitCode !== 0 || !success.stdout.includes('host-ok') || !success.hostPlatform) throw new Error('Successful host result was not preserved.');
  if (failure.exitCode !== 7 || !failure.stderr.includes('host-failed')) throw new Error('Failed host result was not preserved.');
  const retried = await submit({ jobId: 'job-retry', type: 'npm.run', script: 'ok', args: [] });
  if (retried.exitCode !== 0) throw new Error('Pending result was not replayed after bridge disconnect.');
  await waitFor(environment.FAKE_RECONCILED);
  if (await readFile(environment.FAKE_RECONCILED, 'utf8') !== 'job-retry') throw new Error('Ack-lost result was not reconciled before polling.');
  const inFlight = await submit({ jobId: 'job-inflight', type: 'npm.run', script: 'delayed', args: [] });
  const executions = await readFile(join(fixture, 'executions'), 'utf8');
  if (inFlight.exitCode !== 0 || executions !== 'x') throw new Error(`In-flight host job was duplicated across bridge reconnect: exit=${inFlight.exitCode} executions=${executions}.`);

  await writeFile(jobPath, JSON.stringify({ schemaVersion: 1, jobId: 'job-rejected', type: 'npm.run', script: 'ok', args: [] }));
  try { await waitFor(environment.FAKE_REJECTED); }
  catch (error) { throw new Error(`${error.message}; accepted=${existsSync(environment.FAKE_REJECT)} job=${existsSync(jobPath)} result=${existsSync(resultPath) ? await readFile(resultPath, 'utf8') : 'none'}\n${runnerStdout}\n${runnerStderr}`); }
  const rejected = await waitForEvent('runner.error', 'job-rejected');
  if (!rejected.error.includes('conflicting host result replay')) throw new Error('Terminal result rejection was not reported.');
  const afterRejected = await submit({ jobId: 'job-after-rejected', type: 'npm.run', script: 'ok', args: [] });
  if (afterRejected.exitCode !== 0) throw new Error('Terminal result rejection was retried instead of cleared.');

  const requestId = 'npm-script-request-test-add';
  await rm(resultPath, { force: true });
  await writeFile(jobPath, JSON.stringify({ schemaVersion: 1, jobId: requestId, type: 'npm.scripts.request', requestId, operation: 'add', name: 'approved', command: `node -e "process.stdout.write('approved')"` }));
  const event = await waitForEvent('npm.scripts.confirmation_required', requestId);
  await waitFor(resultPath);
  const requested = JSON.parse(await readFile(resultPath, 'utf8'));
  if (requested.status !== 'confirmation_required' || Object.hasOwn(requested, 'code')) throw new Error('Script request exposed its confirmation code.');
  const confirmed = await submit({ jobId: 'confirm-add', type: 'npm.scripts.confirm', requestId, code: event.code });
  const changed = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  if (confirmed.status !== 'success' || !changed.scripts.approved) throw new Error('Approved script was not added.');

  const protectedResult = await submit({ jobId: 'protected-host', type: 'npm.scripts.request', requestId: 'protected-host', operation: 'delete', name: 'host' });
  if (protectedResult.exitCode !== 1 || !protectedResult.stderr.includes('cannot be changed')) throw new Error('Core host script was not protected.');

  const invocations = (await readFile(invocationPath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  if (invocations.length < 2 || invocations.some(value => value.cwd !== dirname(runnerPath))) throw new Error('Docker CLI did not run from the installation directory.');
  const expected = ['compose', 'exec', '-T', 'control', '/usr/local/bin/nestbox-host-bridge'];
  if (!invocations.every(value => expected.every((part, index) => value.args[index] === part))) throw new Error('Docker Compose bridge arguments were incorrect.');

  const exit = new Promise((resolveExit, reject) => { runner.on('error', reject); runner.on('close', code => code === 0 || code === null ? resolveExit() : reject(new Error(`Runner exited ${code}: ${runnerStderr}`))); });
  runner.kill('SIGTERM'); await exit; runner = undefined;

  const onceRunner = spawn(process.execPath, [runnerPath, '--once', '--json'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onceExit = await Promise.race([
    new Promise(resolveExit => onceRunner.once('close', resolveExit)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('--once runner did not exit after an empty poll.')), 5000)),
  ]);
  if (onceExit !== 0) throw new Error(`--once runner exited ${onceExit}.`);

  const stale = spawnSync(process.execPath, [runnerPath, '--once'], {
    env: { ...environment, NESTBOX_HOST_DOCKER_ARGS: JSON.stringify(['-e', `process.stderr.write('nestbox-host-bridge: not found\\n'); process.exit(127)`]) },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (stale.status !== 1 || !stale.stderr.includes('docker compose build control')) throw new Error('Stale control image error was not actionable or terminal.');
  console.log('Host runner stdio transport tests passed.');
} finally {
  runner?.kill('SIGTERM');
  await rm(fixture, { recursive: true, force: true });
}
