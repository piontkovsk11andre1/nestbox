import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';

const installDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = basename(installDirectory) === '.nestbox' ? dirname(installDirectory) : installDirectory;
const workspace = resolve(process.env.NESTBOX_HOST_WORKSPACE || defaultWorkspace);
const canonicalInstallDirectory = await realpath(installDirectory).catch(() => resolve(installDirectory));
const canonicalWorkspace = await realpath(workspace).catch(() => workspace);

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = await readFile(join(installDirectory, '.env'), 'utf8').then(parseEnv, error => error?.code === 'ENOENT' ? {} : Promise.reject(error));
const bindAddress = process.env.BIND_ADDRESS || fileEnv.BIND_ADDRESS || '127.0.0.1';
const gatewayAddress = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress;
const gatewayHost = gatewayAddress.includes(':') && !gatewayAddress.startsWith('[') ? `[${gatewayAddress}]` : gatewayAddress;
const webPort = process.env.WEB_PORT || fileEnv.WEB_PORT || '4180';
const controlUrl = (process.env.NESTBOX_CONTROL_HOST_URL || fileEnv.NESTBOX_CONTROL_HOST_URL || `http://${gatewayHost}:${webPort}/_nestbox`).replace(/\/$/, '');
const tokenPath = process.env.NESTBOX_HOST_TOKEN_FILE || fileEnv.NESTBOX_HOST_TOKEN_FILE || '';
const resolvedTokenPath = tokenPath ? await realpath(resolve(tokenPath)).catch(() => resolve(tokenPath)) : '';
function containsPath(root, target) {
  const child = relative(resolve(root), target);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}
if (resolvedTokenPath && (containsPath(canonicalWorkspace, resolvedTokenPath) || containsPath(canonicalInstallDirectory, resolvedTokenPath))) {
  throw new Error('NESTBOX_HOST_TOKEN_FILE must be outside the workspace and Nestbox installation.');
}
const fileToken = resolvedTokenPath ? await readFile(resolvedTokenPath, 'utf8').then(value => value.trim(), () => '') : '';
const hostToken = fileToken;
if (hostToken.length < 32) throw new Error('NESTBOX_HOST_TOKEN_FILE must contain a token of at least 32 characters.');

const runnerId = randomUUID();
const once = process.argv.slice(2).includes('--once');
const jsonOutput = process.argv.slice(2).includes('--json');
const npmExecutable = process.env.NESTBOX_HOST_NPM || 'npm';
const npmCli = process.env.npm_execpath || (!process.env.NESTBOX_HOST_NPM && process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : '');
const maximumOutputBytes = Number(process.env.NESTBOX_HOST_MAX_OUTPUT_BYTES || 4 * 1024 * 1024);
const approvalTtlMs = Number(process.env.NESTBOX_HOST_APPROVAL_TTL_MS || 5 * 60 * 1000);
const approvalMaximumAttempts = Number(process.env.NESTBOX_HOST_APPROVAL_ATTEMPTS || 3);
const maximumPendingApprovals = Number(process.env.NESTBOX_HOST_APPROVAL_MAX_PENDING || 20);
const hostPlatform = platform();
const hostName = hostname();
const approvals = new Map();
const activeChildren = new Set();
let heartbeatTimer;
let stopping = false;
let shutdownDeadline = 0;

function emit(type, fields = {}) {
  const event = { ...fields, type, timestamp: new Date().toISOString() };
  if (jsonOutput) return process.stdout.write(`${JSON.stringify(event)}\n`);
  if (type === 'runner.ready') console.log(`Nestbox host runner connected to ${controlUrl} for ${workspace}`);
  else if (type === 'npm.scripts.confirmation_required') {
    console.log(`\nApproval ${event.requestId}: ${event.operation} npm script "${event.name}"`);
    if (event.command !== undefined) console.log(`Command: ${event.command}`);
    console.log(`Confirmation code: ${event.code} (expires ${event.expiresAt})\n`);
  } else if (type === 'npm.scripts.changed') console.log(`Approved ${event.operation} for npm script "${event.name}".`);
  else if (type === 'runner.error') console.error(event.error);
}

function headers(json = false) {
  return {
    Authorization: `Bearer ${hostToken}`,
    'X-Nestbox-Runner-Id': runnerId,
    'X-Nestbox-Runner-Pid': String(process.pid),
    'X-Nestbox-Runner-Platform': hostPlatform,
    'X-Nestbox-Runner-Host': hostName,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function controlRequest(method, path, body, timeoutMs = 35000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(controlUrl + path, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(`Control ${method} ${path} returned ${response.status}: ${JSON.stringify(value)}`);
      error.status = response.status;
      throw error;
    }
    return { status: response.status, value };
  } finally {
    clearTimeout(timer);
  }
}

async function packageText() { return readFile(join(workspace, 'package.json'), 'utf8'); }
function parsePackageDocument(text) {
  const document = JSON.parse(text);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('package.json must contain a JSON object.');
  if (document.scripts !== undefined && (!document.scripts || typeof document.scripts !== 'object' || Array.isArray(document.scripts))) throw new Error('package.json scripts must be an object.');
  return document;
}
async function packageDocument() { return parsePackageDocument(await packageText()); }
function hash(contents) { return createHash('sha256').update(contents).digest('hex'); }
async function packageScripts() {
  const document = await packageDocument();
  if (document.scripts === undefined) return {};
  if (!document.scripts || typeof document.scripts !== 'object' || Array.isArray(document.scripts)) throw new Error('package.json scripts must be an object.');
  return document.scripts;
}

async function writePackageJson(document, expectedHash) {
  const path = join(workspace, 'package.json');
  const temporary = `${path}.${runnerId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (hash(await packageText()) !== expectedHash) {
    await unlink(temporary).catch(() => {});
    throw new Error('package.json changed while the approved update was being prepared.');
  }
  try { await rename(temporary, path); }
  catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    const backup = `${path}.${runnerId}.backup`;
    await rename(path, backup);
    try { await rename(temporary, path); await unlink(backup); }
    catch (replaceError) { await rename(backup, path).catch(() => {}); throw replaceError; }
  }
}

function validateScriptChange(job, scripts) {
  if (!['add', 'edit', 'delete'].includes(job.operation)) throw new Error('Unsupported npm script operation.');
  if (typeof job.name !== 'string' || !/^[A-Za-z0-9:_@./ -]{1,128}$/.test(job.name)) throw new Error('Invalid npm script name.');
  if (job.name === 'host') throw new Error('The core host script cannot be changed.');
  const exists = Object.hasOwn(scripts, job.name);
  if (job.operation === 'add' && exists) throw new Error(`npm script already exists: ${job.name}`);
  if (job.operation !== 'add' && !exists) throw new Error(`npm script is not defined: ${job.name}`);
  if (job.operation !== 'delete' && (typeof job.command !== 'string' || !job.command.trim() || job.command.length > 8192)) throw new Error('A non-empty command of at most 8192 characters is required.');
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
  const text = await packageText();
  const scripts = parsePackageDocument(text).scripts || {};
  validateScriptChange(job, scripts);
  const code = randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
  const expiresAtMs = Date.now() + approvalTtlMs;
  approvals.set(job.requestId, { ...job, expectedCommand: Object.hasOwn(scripts, job.name) ? String(scripts[job.name]) : null, expectedPackageHash: hash(text), code, attempts: 0, expiresAtMs });
  const expiresAt = new Date(expiresAtMs).toISOString();
  emit('npm.scripts.confirmation_required', { ...job, code, expiresAt });
  return { jobId: job.jobId, status: 'confirmation_required', requestId: job.requestId, operation: job.operation, name: job.name, expiresAt };
}

async function confirmScriptChange(job) {
  pruneApprovals();
  const approval = approvals.get(job.requestId);
  if (!approval) throw new Error('The npm script approval was not found or has expired.');
  approval.attempts += 1;
  if (String(job.code).trim().toUpperCase() !== approval.code) {
    if (approval.attempts >= approvalMaximumAttempts) approvals.delete(job.requestId);
    throw new Error(approval.attempts >= approvalMaximumAttempts ? 'Invalid confirmation code; the approval has been cancelled.' : 'Invalid confirmation code.');
  }
  const text = await packageText();
  if (hash(text) !== approval.expectedPackageHash) { approvals.delete(job.requestId); throw new Error('package.json changed after approval was requested; request a new approval.'); }
  const document = parsePackageDocument(text), scripts = document.scripts || {};
  validateScriptChange(approval, scripts);
  if (approval.operation === 'delete') delete scripts[approval.name]; else scripts[approval.name] = approval.command;
  document.scripts = scripts;
  await writePackageJson(document, approval.expectedPackageHash);
  approvals.delete(job.requestId);
  emit('npm.scripts.changed', approval);
  return { jobId: job.jobId, status: 'success', requestId: approval.requestId, operation: approval.operation, name: approval.name };
}

function appendLimited(chunks, chunk, state) {
  const buffer = Buffer.from(chunk); state.totalBytes += buffer.length;
  const available = Math.max(0, maximumOutputBytes - state.bytes);
  if (available) chunks.push(buffer.subarray(0, available));
  state.bytes += Math.min(buffer.length, available); if (buffer.length > available) state.truncated = true;
}

async function runNpm(job) {
  const scripts = await packageScripts();
  if (typeof job.script !== 'string' || !Array.isArray(job.args) || !job.args.every(value => typeof value === 'string')) throw new Error('Invalid host npm job.');
  if (job.script === 'host') throw new Error('The host bridge cannot invoke itself.');
  if (!Object.hasOwn(scripts, job.script)) throw new Error(`npm script is not defined: ${job.script}`);
  const args = ['run', job.script, ...(job.args.length ? ['--', ...job.args] : [])];
  const executable = npmCli ? process.execPath : npmExecutable;
  const executableArgs = npmCli ? [npmCli, ...args] : args;
  const startedAt = new Date().toISOString();
  return new Promise(resolveJob => {
    const child = spawn(executable, executableArgs, { cwd: workspace, env: process.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);
    const stdout = [], stderr = [], out = { bytes: 0, totalBytes: 0, truncated: false }, err = { bytes: 0, totalBytes: 0, truncated: false };
    child.stdout.on('data', chunk => appendLimited(stdout, chunk, out)); child.stderr.on('data', chunk => appendLimited(stderr, chunk, err));
    const finish = (exitCode, message = '') => resolveJob({ jobId: job.jobId, exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: message || Buffer.concat(stderr).toString('utf8'), pid: child.pid ?? null, hostPlatform, hostName, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, stdoutTotalBytes: out.totalBytes, stderrTotalBytes: message ? Buffer.byteLength(message) : err.totalBytes, startedAt, completedAt: new Date().toISOString() });
    child.on('error', error => { activeChildren.delete(child); finish(1, error.message); });
    child.on('close', code => { activeChildren.delete(child); finish(Number.isInteger(code) ? code : 1); });
  });
}

async function execute(job) {
  if (job?.schemaVersion !== 1 || typeof job?.jobId !== 'string') throw new Error('Unsupported host job schema.');
  if (job.type === 'npm.scripts.request') return requestScriptChange(job);
  if (job.type === 'npm.scripts.confirm') return confirmScriptChange(job);
  if (job.type === 'npm.run') return runNpm(job);
  throw new Error('Unsupported host job type.');
}

async function stopChildren() {
  await Promise.all([...activeChildren].map(child => new Promise(resolveStop => {
    if (!child.pid) return resolveStop();
    const done = () => resolveStop(); child.once('close', done);
    if (process.platform === 'win32') { const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); killer.once('close', done); killer.once('error', done); }
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { return done(); } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref(); }
  })));
}

async function main() {
  let announced = false;
  let backoffMs = 500;
  while (!stopping) {
    try {
      await controlRequest('POST', '/host/heartbeat', {});
      if (!announced) {
        announced = true;
        heartbeatTimer = setInterval(() => controlRequest('POST', '/host/heartbeat', {}).catch(error => emit('runner.error', { error: error.message })), 2000);
        emit('runner.ready', { workspace, controlUrl, pid: process.pid, platform: hostPlatform, hostname: hostName });
      }
      const response = await controlRequest('GET', '/host/jobs/next?timeout=25', undefined, 35000);
      backoffMs = 500;
      if (response.status === 204) {
        if (once) break;
        continue;
      }
      const job = response.value;
      let result;
      if (stopping) {
        const timestamp = new Date().toISOString();
        result = { jobId: job?.jobId, exitCode: 1, stdout: '', stderr: 'The host runner stopped before executing the assigned job.', pid: null, hostPlatform, hostName, interrupted: true, startedAt: timestamp, completedAt: timestamp };
      }
      else try { result = await execute(job); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); result = { jobId: job?.jobId, exitCode: 1, stdout: '', stderr: message, pid: null, hostPlatform, hostName, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }; }
      do {
        try {
          await controlRequest('POST', `/host/jobs/${encodeURIComponent(result.jobId)}/result`, result);
          break;
        } catch (error) {
          if (error.status && error.status < 500) { emit('runner.error', { error: error.message }); break; }
          await new Promise(resolveWait => setTimeout(resolveWait, backoffMs));
          backoffMs = Math.min(10000, backoffMs * 2);
        }
      } while (!stopping || Date.now() < shutdownDeadline);
      if (once) break;
    } catch (error) {
      if (error.status === 401) throw error;
      emit('runner.error', { error: `${error.message}; reconnecting` });
      await new Promise(resolveWait => setTimeout(resolveWait, backoffMs));
      backoffMs = Math.min(10000, backoffMs * 2);
    }
  }
  clearInterval(heartbeatTimer);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  shutdownDeadline = Date.now() + 5000;
  clearInterval(heartbeatTimer);
  stopChildren().catch(error => emit('runner.error', { error: error.message || String(error) }));
});
main().catch(error => { emit('runner.error', { error: error.message || String(error) }); clearInterval(heartbeatTimer); stopChildren().finally(() => process.exit(1)); });
