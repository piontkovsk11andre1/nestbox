import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

const installDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = basename(installDirectory) === '.nestbox' ? dirname(installDirectory) : installDirectory;
const workspace = resolve(process.env.NESTBOX_HOST_WORKSPACE || defaultWorkspace);
const hostPlatform = platform();
const hostName = hostname();
// Stable for this runner process; each Docker Compose exec gets a new session ID.
const runnerId = `runner-${randomUUID()}`;
const once = process.argv.slice(2).includes('--once');
const jsonOutput = process.argv.slice(2).includes('--json');
const dockerExecutable = process.env.NESTBOX_HOST_DOCKER || 'docker';
const dockerPrefixArgs = process.env.NESTBOX_HOST_DOCKER_ARGS ? JSON.parse(process.env.NESTBOX_HOST_DOCKER_ARGS) : [];
if (!Array.isArray(dockerPrefixArgs) || !dockerPrefixArgs.every(value => typeof value === 'string')) throw new Error('NESTBOX_HOST_DOCKER_ARGS must be a JSON string array.');
const npmExecutable = process.env.NESTBOX_HOST_NPM || 'npm';
const npmCli = process.env.npm_execpath || (!process.env.NESTBOX_HOST_NPM && process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : '');
const maximumOutputBytes = Number(process.env.NESTBOX_HOST_MAX_OUTPUT_BYTES || 4 * 1024 * 1024);
const approvalTtlMs = Number(process.env.NESTBOX_HOST_APPROVAL_TTL_MS || 5 * 60 * 1000);
const approvalMaximumAttempts = Number(process.env.NESTBOX_HOST_APPROVAL_ATTEMPTS || 3);
const maximumPendingApprovals = Number(process.env.NESTBOX_HOST_APPROVAL_MAX_PENDING || 20);
const approvals = new Map();
const activeChildren = new Set();
let activeBridge;
let stopping = false;
let announced = false;
let activeJobId;
let activeJobPromise;
let retainedResult;

function emit(type, fields = {}) {
  const event = { ...fields, type, timestamp: new Date().toISOString() };
  if (jsonOutput) return process.stdout.write(`${JSON.stringify(event)}\n`);
  if (type === 'runner.ready') console.log(`Nestbox host runner connected through Docker Compose for ${workspace}`);
  else if (type === 'npm.scripts.confirmation_required') {
    console.log(`\nApproval ${event.requestId}: ${event.operation} npm script "${event.name}"`);
    if (event.command !== undefined) console.log(`Command: ${event.command}`);
    console.log(`Confirmation code: ${event.code} (expires ${event.expiresAt})\n`);
  } else if (type === 'npm.scripts.changed') console.log(`Approved ${event.operation} for npm script "${event.name}".`);
  else if (type === 'runner.error') console.error(event.error);
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

function sendBridge(child, message) {
  if (!child.stdin.writable) throw new Error('The Docker Compose bridge input closed unexpectedly.');
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, ...message })}\n`);
}

function bridgeSession() {
  const sessionId = randomUUID();
  const args = [...dockerPrefixArgs, 'compose', 'exec', '-T', 'control', '/usr/local/bin/nestbox-host-bridge'];
  const child = spawn(dockerExecutable, args, { cwd: installDirectory, env: process.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  activeBridge = child;
  let diagnostics = '', buffer = '', settled = false;
  const finish = (resolveSession, rejectSession, error, value) => {
    if (settled) return;
    settled = true;
    if (activeBridge === child) activeBridge = undefined;
    error ? rejectSession(error) : resolveSession(value);
  };
  return new Promise((resolveSession, rejectSession) => {
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => {
      diagnostics = (diagnostics + chunk.toString('utf8')).slice(-65536);
      if (!jsonOutput) process.stderr.write(chunk);
    });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
        child.stdin.end();
        finish(resolveSession, rejectSession, new Error('The host bridge protocol line exceeded 64 MiB.'));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { finish(resolveSession, rejectSession, new Error('The host bridge returned invalid JSON.')); child.stdin.end(); return; }
        if (message?.protocolVersion !== 1 || typeof message.type !== 'string') {
          finish(resolveSession, rejectSession, new Error('The host bridge returned an unsupported protocol message.')); child.stdin.end(); return;
        }
        if (message.type === 'ready') {
          if (!announced) {
            announced = true;
            emit('runner.ready', { workspace, pid: process.pid, platform: hostPlatform, hostname: hostName });
          }
        } else if (message.type === 'idle' && once && !retainedResult && !activeJobPromise) {
          child.stdin.end();
          finish(resolveSession, rejectSession, null, { done: true });
        } else if (message.type === 'job') {
          const job = message.job;
          if (retainedResult) {
            if (job?.jobId !== retainedResult.jobId) { finish(resolveSession, rejectSession, new Error('The bridge assigned new work before acknowledging the previous result.')); child.stdin.end(); }
            else sendBridge(child, { type: 'result', result: retainedResult });
            continue;
          }
          if (activeJobPromise && activeJobId !== job?.jobId) {
            finish(resolveSession, rejectSession, new Error('The bridge assigned new work while another host job was still running.')); child.stdin.end(); continue;
          }
          if (!activeJobPromise) {
            activeJobId = job?.jobId;
            activeJobPromise = Promise.resolve().then(async () => {
              if (stopping) {
                const timestamp = new Date().toISOString();
                return { jobId: job?.jobId, exitCode: 1, stdout: '', stderr: 'The host runner stopped before executing the assigned job.', pid: null, hostPlatform, hostName, interrupted: true, startedAt: timestamp, completedAt: timestamp };
              }
              try { return await execute(job); }
              catch (error) { return { jobId: job?.jobId, exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), pid: null, hostPlatform, hostName, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }; }
            }).then(result => {
              retainedResult = result;
              activeJobId = undefined;
              activeJobPromise = undefined;
              return result;
            });
          }
          activeJobPromise.then(result => { if (!settled) sendBridge(child, { type: 'result', result }); }).catch(error => {
            child.stdin.end();
            finish(resolveSession, rejectSession, error);
          });
        } else if (message.type === 'result.ack') {
          if (!retainedResult || message.jobId !== retainedResult.jobId) { finish(resolveSession, rejectSession, new Error('The bridge acknowledged an unknown result.')); child.stdin.end(); return; }
          retainedResult = undefined;
          if (once) { child.stdin.end(); finish(resolveSession, rejectSession, null, { done: true }); }
        } else if (message.type === 'gone') {
          if (retainedResult?.jobId === message.jobId) retainedResult = undefined;
          emit('runner.error', { jobId: message.jobId, error: message.error || 'The assigned host job is no longer available.' });
          if (once) { child.stdin.end(); finish(resolveSession, rejectSession, null, { done: true }); }
        } else if (message.type === 'result.rejected') {
          if (retainedResult?.jobId === message.jobId) retainedResult = undefined;
          emit('runner.error', { jobId: message.jobId, error: message.error || 'Control rejected the retained host result.' });
          if (once) { child.stdin.end(); finish(resolveSession, rejectSession, null, { done: true }); }
        }
      }
    });
    child.once('error', error => finish(resolveSession, rejectSession, new Error(`Unable to start Docker Compose: ${error.message}`)));
    child.once('close', code => {
      if (settled) return;
      const stale = /nestbox-host-bridge|not found|no such file/i.test(diagnostics) || code === 126 || code === 127;
      const message = stale
        ? 'The control image is stale or missing the Nestbox host bridge. Run `docker compose build control` and `docker compose up -d control`, then retry.'
        : `Docker Compose host bridge exited with code ${code}${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}`;
      const error = new Error(message);
      if (stale) error.code = 'STALE_CONTROL_IMAGE';
      finish(resolveSession, rejectSession, stopping ? null : error, { done: stopping });
    });
    sendBridge(child, { type: 'hello', runnerId, sessionId, metadata: { pid: process.pid, platform: hostPlatform, hostname: hostName }, ...(retainedResult ? { retainedResult } : {}) });
  });
}

async function main() {
  let backoffMs = 500;
  while (!stopping) {
    try {
      const session = bridgeSession();
      const outcome = await session;
      backoffMs = 500;
      if (outcome?.done) break;
    } catch (error) {
      if (error.code === 'STALE_CONTROL_IMAGE') throw error;
      emit('runner.error', { error: `${error.message}; reconnecting` });
      await new Promise(resolveWait => setTimeout(resolveWait, backoffMs));
      backoffMs = Math.min(10000, backoffMs * 2);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  activeBridge?.stdin.end();
  const bridge = activeBridge;
  if (bridge?.pid) setTimeout(() => {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(bridge.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else try { process.kill(-bridge.pid, 'SIGTERM'); } catch {}
  }, 2000).unref();
  stopChildren().catch(error => emit('runner.error', { error: error.message || String(error) }));
});
main().catch(error => { emit('runner.error', { error: error.message || String(error) }); stopChildren().finally(() => process.exit(1)); });
