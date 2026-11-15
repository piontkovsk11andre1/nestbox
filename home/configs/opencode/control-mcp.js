#!/usr/bin/env node
'use strict';

const baseUrl = (process.env.NESTBOX_CONTROL_URL || 'http://control:4088').replace(/\/$/, '');
const timeoutMs = Number(process.env.NESTBOX_CONTROL_TIMEOUT_MS || '30000');
const tools = [
  { name: 'docker_exec', description: 'Run a command in an allowed Compose service.', inputSchema: { type: 'object', properties: { machine: { type: 'string' }, workdir: { type: 'string' }, command: { type: 'array', items: { type: 'string' } }, user: { type: 'string' }, detach: { type: 'boolean' } }, required: ['machine', 'workdir', 'command'], additionalProperties: false } },
];

function request(method, path, body) {
  const url = new URL(baseUrl + path);
  const transport = require(url.protocol === 'https:' ? 'https' : 'http');
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { accept: 'application/json' };
    if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    const client = transport.request({ method, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers }, response => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = chunks.join('');
        let value = null;
        try { value = text ? JSON.parse(text) : null; } catch { value = text; }
        if (response.statusCode >= 400) reject(new Error(`Control API ${method} ${path} returned ${response.statusCode}: ${JSON.stringify(value)}`));
        else resolve(value);
      });
    });
    client.setTimeout(timeoutMs, () => client.destroy(new Error('Control API request timed out')));
    client.on('error', reject);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object.');
  return value;
}

async function call(name, raw) {
  const args = object(raw || {});
  if (name === 'docker_exec') {
    if (typeof args.machine !== 'string' || !args.machine) throw new Error('machine must be a non-empty string.');
    if (typeof args.workdir !== 'string' || !args.workdir.startsWith('/')) throw new Error('workdir must be an absolute path.');
    if (!Array.isArray(args.command) || !args.command.length || !args.command.every(value => typeof value === 'string')) throw new Error('command must be a non-empty string array.');
    const body = { command: args.command, workdir: args.workdir };
    if (args.user) body.user = String(args.user);
    if (args.detach !== undefined) body.detach = Boolean(args.detach);
    return { machine: args.machine, workdir: args.workdir, command: args.command, result: await request('POST', `/containers/${encodeURIComponent(args.machine)}/exec`, body) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function handle(message) {
  if (message.method === 'initialize') return emit({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nestbox-control-mcp', version: '0.6.0' } } });
  if (message.method === 'initialized') return;
  if (message.method === 'tools/list') return emit({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method === 'tools/call') {
    try {
      const output = await call(message.params?.name, message.params?.arguments);
      emit({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] } });
    } catch (error) {
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message || 'Tool execution failed.' } });
    }
    return;
  }
  if (message.id !== undefined) emit({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not supported: ${message.method}` } });
}

let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString('utf8');
  let boundary;
  while ((boundary = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, boundary).replace(/\r$/, ''); input = input.slice(boundary + 1);
    if (!line) continue;
    try { Promise.resolve(handle(JSON.parse(line))).catch(error => emit({ jsonrpc: '2.0', id: null, error: { code: -32603, message: error.message } })); }
    catch (error) { emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } }); }
  }
});
