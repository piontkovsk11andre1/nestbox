import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';

const installDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = basename(installDirectory) === '.nestbox' ? dirname(installDirectory) : installDirectory;
const workspace = resolve(process.env.NESTBOX_HOST_WORKSPACE || defaultWorkspace);
const runnerConfig = await readFile(join(installDirectory, '.runtime', 'host-runner.json'), 'utf8')
  .then(value => JSON.parse(value), error => error?.code === 'ENOENT' ? {} : Promise.reject(error));
const queueRoot = resolve(process.env.NESTBOX_HOST_QUEUE || runnerConfig.queue || join(installDirectory, '.runtime', 'host-runner'));
const queueRelative = relative(workspace, queueRoot);
if (queueRelative === '' || (!queueRelative.startsWith('..') && !isAbsolute(queueRelative))) {
  throw new Error('NESTBOX host queue must be outside the mounted workspace.');
}
const requestsDirectory = join(queueRoot, 'requests');
const runningDirectory = join(queueRoot, 'running');
const resultsDirectory = join(queueRoot, 'results');
const heartbeatPath = join(queueRoot, 'heartbeat.json');
const lockPath = join(queueRoot, 'runner.lock');
const takeoverPath = join(queueRoot, 'takeover.lock');
const instanceId = `${process.pid}-${Date.now()}`;
const once = process.argv.slice(2).includes('--once');
const jsonOutput = process.argv.slice(2).includes('--json');
const npmExecutable = process.env.NESTBOX_HOST_NPM || 'npm';
const maximumOutputBytes = Number(process.env.NESTBOX_HOST_MAX_OUTPUT_BYTES || 4 * 1024 * 1024);
const approvalTtlMs = Number(process.env.NESTBOX_HOST_APPROVAL_TTL_MS || 5 * 60 * 1000);
const approvalMaximumAttempts = Number(process.env.NESTBOX_HOST_APPROVAL_ATTEMPTS || 3);
const maximumPendingApprovals = Number(process.env.NESTBOX_HOST_APPROVAL_MAX_PENDING || 20);
const hostPlatform = platform();
const hostName = hostname();
const approvals = new Map();
const activeChildren = new Set();
let heartbeatTimer;

function emit(type, fields = {}) {
  const event = { ...fields, type, timestamp: new Date().toISOString() };
  if (jsonOutput) return process.stdout.write(`${JSON.stringify(event)}\n`);
  if (type === 'runner.ready') console.log(`Nestbox host runner listening in ${workspace}`);
  else if (type === 'npm.scripts.confirmation_required') {
    console.log(`\nApproval ${event.requestId}: ${event.operation} npm script "${event.name}"`);
    if (event.command !== undefined) console.log(`Command: ${event.command}`);
    console.log(`Confirmation code: ${event.code} (expires ${event.expiresAt})\n`);
  } else if (type === 'npm.scripts.changed') console.log(`Approved ${event.operation} for npm script "${event.name}".`);
  else if (type === 'runner.error') console.error(event.error);
}

async function atomicJson(path, value) {
  const temporary = `${path}.${instanceId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await unlink(path).catch(() => {});
    await rename(temporary, path);
  }
}

async function packageDocument() {
  const document = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('package.json must contain a JSON object.');
  return document;
}

async function packageHash() {
  const contents = await readFile(join(workspace, 'package.json'));
  return createHash('sha256').update(contents).digest('hex');
}

async function packageScripts() {
  const document = await packageDocument();
  if (document.scripts === undefined) return {};
  if (!document.scripts || typeof document.scripts !== 'object' || Array.isArray(document.scripts)) {
    throw new Error('package.json scripts must be an object.');
  }
  return document.scripts;
}

async function writePackageJson(document, expectedHash) {
  const path = join(workspace, 'package.json');
  const temporary = `${path}.${instanceId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (expectedHash && await packageHash() !== expectedHash) {
    await unlink(temporary).catch(() => {});
    throw new Error('package.json changed while the approved update was being prepared.');
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    const backup = `${path}.${instanceId}.backup`;
    await rename(path, backup);
    try {
      await rename(temporary, path);
      await unlink(backup);
    } catch (replaceError) {
      await rename(backup, path).catch(() => {});
      throw replaceError;
    }
  }
}

function validateScriptChange(job, scripts) {
  if (!['add', 'edit', 'delete'].includes(job.operation)) throw new Error('Unsupported npm script operation.');
  if (typeof job.name !== 'string' || !/^[A-Za-z0-9:_@./ -]{1,128}$/.test(job.name)) throw new Error('Invalid npm script name.');
  if (job.name === 'host') throw new Error('The core host script cannot be changed.');
  const exists = Object.hasOwn(scripts, job.name);
  if (job.operation === 'add' && exists) throw new Error(`npm script already exists: ${job.name}`);
  if (job.operation !== 'add' && !exists) throw new Error(`npm script is not defined: ${job.name}`);
  if (job.operation !== 'delete' && (typeof job.command !== 'string' || !job.command.trim() || job.command.length > 8192)) {
    throw new Error('A non-empty command of at most 8192 characters is required.');
  }
  if (job.operation === 'delete' && job.command !== undefined) throw new Error('Delete does not accept a command.');
}

function pruneApprovals() {
  const now = Date.now();
  for (const [requestId, approval] of approvals) if (approval.expiresAtMs <= now) approvals.delete(requestId);
}

async function requestScriptChange(job) {
  if (typeof job.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(job.requestId)) throw new Error('A valid request ID is required.');
  pruneApprovals();
  if (approvals.has(job.requestId)) throw new Error('The request ID is already pending.');
  if (approvals.size >= maximumPendingApprovals) throw new Error('Too many npm script approvals are pending.');
  const scripts = await packageScripts();
  validateScriptChange(job, scripts);
  const code = randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
  const expiresAtMs = Date.now() + approvalTtlMs;
  approvals.set(job.requestId, {
    ...job,
    expectedCommand: Object.hasOwn(scripts, job.name) ? String(scripts[job.name]) : null,
    expectedPackageHash: await packageHash(),
    code,
    attempts: 0,
    expiresAtMs,
  });
  const expiresAt = new Date(expiresAtMs).toISOString();
  emit('npm.scripts.confirmation_required', { ...job, code, expiresAt });
  return { jobId: job.jobId, status: 'confirmation_required', requestId: job.requestId, operation: job.operation, name: job.name, expiresAt };
}

async function confirmScriptChange(job) {
  if (typeof job.requestId !== 'string' || typeof job.code !== 'string') throw new Error('A request ID and confirmation code are required.');
  pruneApprovals();
  const approval = approvals.get(job.requestId);
  if (!approval) throw new Error('The npm script approval was not found or has expired.');
  approval.attempts += 1;
  if (job.code.trim().toUpperCase() !== approval.code) {
    if (approval.attempts >= approvalMaximumAttempts) approvals.delete(job.requestId);
    throw new Error(approval.attempts >= approvalMaximumAttempts ? 'Invalid confirmation code; the approval has been cancelled.' : 'Invalid confirmation code.');
  }
  const document = await packageDocument();
  if (await packageHash() !== approval.expectedPackageHash) {
    approvals.delete(job.requestId);
    throw new Error('package.json changed after approval was requested; request a new approval.');
  }
  const scripts = document.scripts || {};
  const currentCommand = Object.hasOwn(scripts, approval.name) ? String(scripts[approval.name]) : null;
  if (currentCommand !== approval.expectedCommand) {
    approvals.delete(job.requestId);
    throw new Error('package.json changed after approval was requested; request a new approval.');
  }
  validateScriptChange(approval, scripts);
  if (approval.operation === 'delete') delete scripts[approval.name];
  else scripts[approval.name] = approval.command;
  document.scripts = scripts;
  await writePackageJson(document, approval.expectedPackageHash);
  approvals.delete(job.requestId);
  emit('npm.scripts.changed', approval);
  return { jobId: job.jobId, status: 'success', requestId: approval.requestId, operation: approval.operation, name: approval.name };
}

function appendLimited(chunks, chunk, state) {
  const buffer = Buffer.from(chunk);
  state.totalBytes += buffer.length;
  const available = Math.max(0, maximumOutputBytes - state.bytes);
  if (available) chunks.push(buffer.subarray(0, available));
  state.bytes += Math.min(buffer.length, available);
  if (buffer.length > available) state.truncated = true;
}

async function runNpm(job) {
  const scripts = await packageScripts();
  if (typeof job.script !== 'string' || !Array.isArray(job.args) || !job.args.every(value => typeof value === 'string')) throw new Error('Invalid host npm job.');
  if (job.script === 'host') throw new Error('The host bridge cannot invoke itself.');
  if (!Object.hasOwn(scripts, job.script)) throw new Error(`npm script is not defined: ${job.script}`);
  const args = ['run', job.script, ...(job.args.length ? ['--', ...job.args] : [])];
  const executable = process.env.npm_execpath ? process.execPath : npmExecutable;
  const executableArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  const startedAt = new Date().toISOString();
  return await new Promise(resolveJob => {
    const child = spawn(executable, executableArgs, { cwd: workspace, env: process.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    const stdout = [], stderr = [];
    const out = { bytes: 0, totalBytes: 0, truncated: false }, err = { bytes: 0, totalBytes: 0, truncated: false };
    child.stdout.on('data', chunk => appendLimited(stdout, chunk, out));
    child.stderr.on('data', chunk => appendLimited(stderr, chunk, err));
    const result = (exitCode, message = '') => resolveJob({
      jobId: job.jobId, exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: message || Buffer.concat(stderr).toString('utf8'),
      pid: child.pid ?? null, hostPlatform, hostName, stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
      stdoutTotalBytes: out.totalBytes, stderrTotalBytes: message ? Buffer.byteLength(message) : err.totalBytes,
      startedAt, completedAt: new Date().toISOString(),
    });
    child.on('error', error => { activeChildren.delete(child); result(1, error.message); });
    child.on('close', code => { activeChildren.delete(child); result(Number.isInteger(code) ? code : 1); });
  });
}

async function execute(job) {
  if (job?.schemaVersion !== 1 || typeof job?.jobId !== 'string') throw new Error('Unsupported host job schema.');
  if (job.type === 'npm.scripts.request') return requestScriptChange(job);
  if (job.type === 'npm.scripts.confirm') return confirmScriptChange(job);
  if (job.type === 'npm.run') return runNpm(job);
  throw new Error('Unsupported host job type.');
}

async function processRequest(path) {
  const name = basename(path);
  const runningPath = join(runningDirectory, name);
  try { await rename(path, runningPath); } catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) return; throw error; }
  const claimedJobId = name.replace(/\.json$/, '');
  let result;
  try {
    const job = JSON.parse(await readFile(runningPath, 'utf8'));
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(claimedJobId) || job?.jobId !== claimedJobId) throw new Error('Host job ID must match its safe queue filename.');
    result = await execute(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { jobId: claimedJobId, exitCode: 1, stdout: '', stderr: message, pid: null, hostPlatform, hostName, stdoutTruncated: false, stderrTruncated: false, stdoutTotalBytes: 0, stderrTotalBytes: Buffer.byteLength(message), startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  }
  await atomicJson(join(resultsDirectory, `${result.jobId}.json`), result);
  await unlink(runningPath).catch(() => {});
}

async function cleanup() {
  clearInterval(heartbeatTimer);
  await Promise.all([...activeChildren].map(child => new Promise(resolveStop => {
    if (!child.pid) return resolveStop();
    const done = () => resolveStop();
    child.once('close', done);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', done); killer.once('error', done);
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { return done(); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref();
    }
  })));
  try {
    if ((await readFile(lockPath, 'utf8')).trim() === instanceId) await Promise.all([unlink(lockPath).catch(() => {}), unlink(heartbeatPath).catch(() => {})]);
  } catch {}
}

async function main() {
  await Promise.all([mkdir(requestsDirectory, { recursive: true }), mkdir(runningDirectory, { recursive: true }), mkdir(resultsDirectory, { recursive: true })]);
  try {
    const lock = await open(lockPath, 'wx'); await lock.writeFile(`${instanceId}\n`); await lock.close();
  } catch (error) {
    const heartbeatStale = await stat(heartbeatPath).then(value => Date.now() - value.mtimeMs > 5000, () => null);
    const lockOld = await stat(lockPath).then(value => Date.now() - value.mtimeMs > 5000, () => false);
    const stale = heartbeatStale === true || (heartbeatStale === null && lockOld);
    if (error?.code !== 'EEXIST' || !stale) throw error;
    let takeover;
    try {
      takeover = await open(takeoverPath, 'wx');
      await takeover.writeFile(`${instanceId}\n`);
    } catch {
      throw new Error('Another host runner is recovering the stale lock.');
    }
    try {
      await unlink(heartbeatPath).catch(() => {});
      await unlink(lockPath);
      const lock = await open(lockPath, 'wx'); await lock.writeFile(`${instanceId}\n`); await lock.close();
    } finally {
      await takeover.close();
      await unlink(takeoverPath).catch(() => {});
    }
  }
  for (const name of await readdir(runningDirectory)) {
    if (!name.endsWith('.json')) continue;
    const jobId = name.replace(/\.json$/, '');
    const message = 'Host runner stopped while this job was active; the job was not replayed.';
    await atomicJson(join(resultsDirectory, name), { jobId, exitCode: 1, stdout: '', stderr: message, pid: null, hostPlatform, hostName, interrupted: true, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    await unlink(join(runningDirectory, name));
  }
  const heartbeat = () => atomicJson(heartbeatPath, { schemaVersion: 1, instanceId, pid: process.pid, hostname: hostName, platform: hostPlatform, workspace, updatedAt: new Date().toISOString() });
  await heartbeat(); heartbeatTimer = setInterval(() => heartbeat().catch(error => emit('runner.error', { error: error.message })), 1000);
  emit('runner.ready', { workspace, pid: process.pid, platform: hostPlatform, hostname: hostName });
  do {
    for (const name of (await readdir(requestsDirectory)).filter(name => name.endsWith('.json')).sort()) await processRequest(join(requestsDirectory, name));
    if (!once) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  } while (!once);
  await cleanup();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => cleanup().finally(() => process.exit(0)));
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); cleanup().finally(() => process.exit(1)); });
