#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));

const copyEntries = [
  'docker',
  'home',
  'tests',
  'docker-compose.yaml',
  '.dockerignore',
  '.env.example',
  '.gitattributes',
  'INSTALL.md',
  'README.md',
  'LICENSE'
];

function parseArgs(argv) {
  const options = {
    target: '',
    layout: '',
    yes: false,
    git: true,
    help: false
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-git') options.git = false;
    else if (arg === '--layout') options.layout = argv[++index] || '';
    else if (arg.startsWith('--layout=')) options.layout = arg.slice('--layout='.length);
    else if (arg === '--target') options.target = argv[++index] || '';
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (!arg.startsWith('-') && !options.target) options.target = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Create a Nestbox project.\n\nUsage:\n  npm create @p10i/nestbox@latest [target] [options]\n  npx @p10i/create-nestbox [target] [options]\n\nOptions:\n  --layout current|nestbox  Install directly into target or into target/.nestbox\n  --target <path>          Target directory\n  --yes, -y                Use defaults for missing prompts\n  --no-git                 Do not initialize fresh installation Git history\n  --help, -h               Show this help\n`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isDirectoryEmpty(path) {
  if (!(await pathExists(path))) return true;
  const entries = await readdir(path);
  return entries.length === 0;
}

function validateLayout(layout) {
  if (layout !== 'current' && layout !== 'nestbox') {
    throw new Error('Layout must be "current" or "nestbox".');
  }
}

async function ask(question, defaultValue, rl, yes) {
  if (yes) return defaultValue;
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function copyTemplate(installDir) {
  for (const entry of copyEntries) {
    await cp(join(packageRoot, entry), join(installDir, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
      mode: constants.COPYFILE_FICLONE
    });
  }

  await cp(join(packageRoot, 'template.gitignore'), join(installDir, '.gitignore'), {
    errorOnExist: true,
    force: false
  });
}

async function configureInstance(installDir, workspaceDir, layout) {
  await cp(join(installDir, '.env.example'), join(installDir, '.env'), {
    errorOnExist: true,
    force: false
  });

  const instanceExample = join(installDir, 'home', 'configs', 'opencode', 'instance.example.md');
  const instancePath = join(installDir, 'home', 'configs', 'opencode', 'instance.md');
  let instance = await readFile(instanceExample, 'utf8');

  const workspaceDescription = layout === 'nestbox'
    ? 'the parent workspace directory'
    : 'the installation directory';
  const layoutDescription = layout === 'nestbox'
    ? '.nestbox'
    : 'current directory';

  instance = instance
    .replace('- Layout: current directory.', `- Layout: ${layoutDescription}.`)
    .replace('- Workspace: `/workspace` maps to the installation directory.', `- Workspace: \`/workspace\` maps to ${workspaceDescription}.`)
    .replace('- Upstream source revision: record during installation.', `- Upstream source revision: npm package ${packageJson.name}@${packageJson.version}.`)
    .replace('- Commit policy: unconfigured; ask before any commit until the installer replaces this line with the user\'s automatic, per-commit confirmation, or no-commit choice.', '- Commit policy: per-commit confirmation; ask before each commit.')
    .trimEnd();

  instance += `\n\n- Host installation path: ${installDir}\n- Host workspace path: ${workspaceDir}\n`;

  await writeFile(instancePath, instance, 'utf8');
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

function initGit(installDir) {
  if (!commandExists('git')) return false;
  const result = spawnSync('git', ['init'], { cwd: installDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error('git init failed.');
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const targetInput = options.target || await ask('Target directory', '.', rl, options.yes);
    const layoutInput = options.layout || await ask('Layout: current or nestbox', 'nestbox', rl, options.yes);
    validateLayout(layoutInput);

    const workspaceDir = resolve(process.cwd(), targetInput);
    const installDir = layoutInput === 'nestbox' ? join(workspaceDir, '.nestbox') : workspaceDir;

    if (!(await isDirectoryEmpty(installDir))) {
      throw new Error(`Refusing to overwrite non-empty installation target: ${installDir}`);
    }

    await mkdir(installDir, { recursive: true });
    await copyTemplate(installDir);
    await configureInstance(installDir, workspaceDir, layoutInput);
    const gitInitialized = options.git ? initGit(installDir) : false;

    console.log('\nNestbox project created.');
    console.log(`Installation: ${installDir}`);
    console.log(`Workspace: ${workspaceDir}`);
    console.log(`Git initialized: ${gitInitialized ? 'yes' : 'no'}`);
    console.log('\nNext steps:');
    console.log(`  cd ${installDir}`);
    console.log('  Edit .env and set COMPOSE_PROJECT_NAME, WEB_PORT, OpenCode credentials, and provider keys.');
    console.log('  docker compose config --quiet');
    console.log('  docker compose up -d --build');
    console.log(process.platform === 'win32' ? '  .\\tests\\nestbox.ps1' : '  bash tests/nestbox.sh');
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`create-nestbox: ${error.message}`);
  process.exit(1);
});
