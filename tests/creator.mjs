import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'nestbox-creator-'));

function create(target, layout) {
  const result = spawnSync(process.execPath, [resolve('bin/create-nestbox.js'), target, '--layout', layout, '--yes', '--no-git'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Creator failed for ${layout}: ${result.stderr || result.stdout}`);
  if (/npm run host|test:host/.test(result.stdout)) throw new Error('Creator still asks for a host runner.');
}

try {
  const nested = join(fixture, 'nested');
  await mkdir(nested);
  const manifest = '{"name":"existing","scripts":{"host":"node app.mjs","build":"node build.mjs"}}\n';
  await writeFile(join(nested, 'package.json'), manifest);
  create(nested, 'nestbox');
  if (await readFile(join(nested, 'package.json'), 'utf8') !== manifest) throw new Error('Creator modified the workspace package.json.');
  const nestedEnv = await readFile(join(nested, '.nestbox', '.env'), 'utf8');
  if (!/^WORKSPACE_PATH=\.\.$/m.test(nestedEnv)) throw new Error('Nested workspace path is incorrect.');

  const direct = join(fixture, 'direct');
  create(direct, 'current');
  const directEntries = await readdir(direct);
  const directConfig = JSON.parse(await readFile(join(direct, 'home/configs/opencode/opencode.json'), 'utf8'));
  if (!directConfig.mcp['do-md']?.command.includes('--url')) throw new Error('Creator omitted the default remote do-md MCP.');
  await readFile(join(direct, 'docker/do-md/Dockerfile'), 'utf8');
  for (const entry of ['package.json', 'package.host.json', 'host-runner.mjs']) {
    if (directEntries.includes(entry)) throw new Error(`Creator installed obsolete host file: ${entry}`);
  }

  const empty = join(fixture, 'empty');
  create(empty, 'nestbox');
  if ((await readdir(empty)).includes('package.json')) throw new Error('Creator created a workspace manifest.');

  console.log('Creator tests passed.');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
