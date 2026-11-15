import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';

// This file resolves the image-local installation, not a workspace dependency.
// In source tests the same code resolves the publisher's dev dependency.
const require = createRequire(import.meta.url);
const packagePath = require.resolve('@p10i/do-md/package.json');
const packageRoot = dirname(packagePath);
const dependencyRequire = createRequire(packagePath);
const definitions = await import(pathToFileURL(join(packageRoot, 'sources/Service/Definitions.mjs')));
const names = ['validate', 'export', 'create', 'set', 'render', 'match', 'query', 'reference'];
const [major, minor] = require(packagePath).version.split('.').map(Number);
assert.ok(major > 1 || (major === 1 && minor >= 4), 'Nestbox needs do-md 1.4.0 or newer');
assert.equal(definitions.API_VERSION, 1, 'Nestbox requires do-md HTTP API v1');
assert.ok(names.every(name => definitions.TOOL_NAMES.includes(name)));
assert.equal(typeof (await import(pathToFileURL(join(packageRoot, 'sources/HttpServer.mjs')))).createServer, 'function');

const mode = process.argv[2] ?? '--package';
if (mode === '--package') {
  console.log(`do-md ${require(packagePath).version}: package contract verified`);
} else if (mode === '--health' || mode === '--mcp') {
  const url = (process.env.NESTBOX_DO_MD_URL || 'http://127.0.0.1:8080').replace(/\/*$/, '/');
  const response = await fetch(new URL('v1/capabilities', url), { signal: AbortSignal.timeout(4000), redirect: 'error' });
  assert.equal(response.status, 200);
  const capabilities = await response.json();
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.apiVersion, 1);
  assert.ok(names.every(name => capabilities.commands.some(command => command.name === name && command.inputSchema?.type === 'object')));
  if (mode === '--mcp') {
    const { Client } = await import(pathToFileURL(dependencyRequire.resolve('@modelcontextprotocol/sdk/client/index.js')));
    const { StdioClientTransport } = await import(pathToFileURL(dependencyRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
    const documents = process.env.NESTBOX_DO_MD_TEST_DOCUMENTS || '/documents';
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(packageRoot, 'bin/do-md-mcp.mjs'), '--url', url, '--root', documents, '--timeout-ms', process.env.NESTBOX_DO_MD_TIMEOUT_MS || '20000'], stderr: 'pipe' });
    const client = new Client({ name: 'nestbox-do-md-smoke', version: '0.7.0' });
    try {
      await client.connect(transport);
      assert.ok(client.getServerCapabilities()?.tools);
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(names.every(name => tools.includes(name)));
      for (const tree of ['workspace', 'pages']) {
        // Only these unique, owned fixtures are removed, even on a failed call.
        const directory = await mkdtemp(join(documents, tree, '__nestbox_do_md_mcp_'));
        try {
          await writeFile(join(directory, 'doc.md'), '# Before\n');
          await writeFile(join(directory, 'doc.tpl.md'), '# {% doc.line().as("title") %}\n');
          const file = relative(documents, join(directory, 'doc.md')).replaceAll('\\', '/');
          const template = relative(documents, join(directory, 'doc.tpl.md')).replaceAll('\\', '/');
          const exported = await client.callTool({ name: 'export', arguments: { file, template } });
          assert.equal(exported.isError, false, JSON.stringify(exported));
          assert.deepEqual(JSON.parse(exported.content[0].text).context, { title: 'Before' });
          const changed = await client.callTool({ name: 'set', arguments: { file, template, key: 'title', value: 'Remote' } });
          assert.equal(changed.isError, false, JSON.stringify(changed));
          assert.equal(await readFile(join(directory, 'doc.md'), 'utf8'), '# Remote\n');
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      const reference = await client.readResource({ uri: 'do-md://reference/template-language' });
      assert.match(reference.contents[0].text, /rawUntilElement/);
      console.log(`do-md ${capabilities.version}: remote MCP and both shared mounts verified`);
    } finally { await client.close(); }
  }
} else {
  throw new Error(`Unknown check mode: ${mode}`);
}
