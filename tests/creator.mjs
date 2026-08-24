import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'nestbox-creator-'));

function create(target, layout) {
  const result = spawnSync(process.execPath, [resolve('bin/create-nestbox.js'), target, '--layout', layout, '--yes', '--no-git'], { encoding: 'utf8', env: { ...process.env, NESTBOX_CREATOR_STATE_ROOT: join(fixture, 'state') } });
  if (result.status !== 0) throw new Error(`Creator failed for ${layout}: ${result.stderr || result.stdout}`);
}

try {
  const nested = join(fixture, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'existing', scripts: { build: 'node build.mjs' } }));
  create(nested, 'nestbox');
  const nestedPackage = JSON.parse(await readFile(join(nested, 'package.json'), 'utf8'));
  if (nestedPackage.name !== 'existing' || nestedPackage.scripts.build !== 'node build.mjs') throw new Error('Creator replaced existing package metadata.');
  if (nestedPackage.scripts.host !== 'node .nestbox/host-runner.mjs') throw new Error('Nested host script has the wrong path.');
  const nestedEnv = await readFile(join(nested, '.nestbox', '.env'), 'utf8');
  if (!/^WORKSPACE_PATH=\.\.$/m.test(nestedEnv) || /NESTBOX_HOST_TOKEN/.test(nestedEnv)) throw new Error('Nested runtime configuration still contains host token state.');
  if ((await readdir(fixture)).includes('state')) throw new Error('Creator wrote external host state.');
  const npmCommand = process.env.npm_execpath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const npmArgs = process.env.npm_execpath ? [process.env.npm_execpath, 'run', 'test:host'] : ['run', 'test:host'];
  const nestedHostTest = spawnSync(npmCommand, npmArgs, { cwd: nested, encoding: 'utf8' });
  if (nestedHostTest.status !== 0) throw new Error(`Nested host test script failed: ${nestedHostTest.error?.message || nestedHostTest.stderr || nestedHostTest.stdout}`);

  const direct = join(fixture, 'direct');
  create(direct, 'current');
  const directPackage = JSON.parse(await readFile(join(direct, 'package.json'), 'utf8'));
  if (directPackage.scripts.host !== 'node host-runner.mjs' || directPackage.scripts['test:host'] !== 'node tests/host-runner.mjs') throw new Error('Direct host scripts have the wrong paths.');

  const conflicting = join(fixture, 'conflicting');
  await mkdir(conflicting);
  await writeFile(join(conflicting, 'package.json'), JSON.stringify({ scripts: { host: 'node something-else.mjs' } }));
  const conflict = spawnSync(process.execPath, [resolve('bin/create-nestbox.js'), conflicting, '--layout', 'nestbox', '--yes', '--no-git'], { encoding: 'utf8', env: { ...process.env, NESTBOX_CREATOR_STATE_ROOT: join(fixture, 'state') } });
  if (conflict.status === 0 || !conflict.stderr.includes('Refusing to overwrite')) throw new Error('Creator accepted a conflicting host script.');

  console.log('Creator tests passed.');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
