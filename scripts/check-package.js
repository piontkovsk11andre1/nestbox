import { access, readFile } from 'node:fs/promises';

const requiredPaths = [
  'bin/create-nestbox.js',
  'docker-compose.yaml',
  '.env.example',
  'template.gitignore',
  'package-lock.json',
  'docker/nginx/Dockerfile',
  'docker/php-fpm/Dockerfile',
  'docker/opencode/Dockerfile',
  'docker/rollup/Dockerfile',
  'docker/control/Dockerfile',
  'docker/control/server.py',
  'docker/do-md/Dockerfile',
  'docker/do-md/check.mjs',
  'CHANGELOG.md',
  'home/configs/opencode/control-mcp.js',
  'home/configs/opencode/instance.example.md',
  'home/code/404.php',
  'tests/nestbox.sh',
  'tests/nestbox.ps1',
  'tests/control.mjs',
  'tests/creator.mjs',
  'tests/do-md.test.mjs',
  'tests/do-md-smoke.php'
];

for (const path of requiredPaths) {
  await access(path);
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (packageJson.name !== '@p10i/create-nestbox') {
  throw new Error('Unexpected package name.');
}

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
if (lock.version !== packageJson.version || lock.packages?.['']?.version !== packageJson.version) {
  throw new Error('Publisher package and lockfile versions must agree.');
}

if (!packageJson.files || packageJson.files.includes('.env')) {
  throw new Error('package.json files must not include .env.');
}

for (const path of ['!**/node_modules/', '!home/code/scripts-bundle.js', '!home/code/scripts-bundle.css']) {
  if (!packageJson.files.includes(path)) throw new Error(`package.json files must include ${path}.`);
}

console.log('Package checks passed.');
