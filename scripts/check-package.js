import { access, readFile } from 'node:fs/promises';

const requiredPaths = [
  'bin/create-nestbox.js',
  'docker-compose.yaml',
  '.env.example',
  'template.gitignore',
  'docker/nginx/Dockerfile',
  'docker/php-fpm/Dockerfile',
  'docker/opencode/Dockerfile',
  'docker/rollup/Dockerfile',
  'docker/control/Dockerfile',
  'docker/control/server.py',
  'host-runner.mjs',
  'package.host.json',
  'CHANGELOG.md',
  'home/configs/opencode/control-mcp.js',
  'home/configs/opencode/instance.example.md',
  'home/code/404.php',
  'tests/nestbox.sh',
  'tests/nestbox.ps1',
  'tests/control.mjs',
  'tests/host-runner.mjs',
  'tests/creator.mjs'
];

for (const path of requiredPaths) {
  await access(path);
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (packageJson.name !== '@p10i/create-nestbox') {
  throw new Error('Unexpected package name.');
}

if (!packageJson.files || packageJson.files.includes('.env')) {
  throw new Error('package.json files must not include .env.');
}

for (const path of ['host-runner.mjs', 'package.host.json']) {
  if (!packageJson.files.includes(path)) throw new Error(`package.json files must include ${path}.`);
}

console.log('Package checks passed.');
