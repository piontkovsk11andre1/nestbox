#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
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
  'host-runner.mjs',
  'package.host.json',
  'docker-compose.yaml',
  '.dockerignore',
  '.env.example',
  '.gitattributes',
  'INSTALL.md',
  'README.md',
  'CHANGELOG.md',
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
  console.log(`Create a Nestbox project.\n\nUsage:\n  npm create @p10i/nestbox@latest [workspace] [options]\n  npx @p10i/create-nestbox [workspace] [options]\n\nOptions:\n  --layout nestbox         Create <workspace>/.nestbox (recommended)\n  --layout current         Put Nestbox files directly in <workspace>\n  --target <path>          Workspace directory\n  --yes, -y                Use defaults and skip confirmation\n  --no-git                 Do not initialize fresh installation Git history\n  --help, -h               Show this help\n`);
}

function printBanner() {
  console.log('\nNestbox Creator');
  console.log('Create an agent-guided Docker workspace for project tools and interfaces.\n');
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
    throw new Error('Layout must be "nestbox" or "current".');
  }
}

async function ask(question, defaultValue, rl, yes) {
  if (yes) return defaultValue;
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askLayout(rl, yes) {
  if (yes) return 'nestbox';

  console.log('Where should Nestbox files go?');
  console.log('  1. Keep Nestbox in .nestbox (recommended)');
  console.log('     Creates <workspace>/.nestbox and keeps Nestbox separate from project files.');
  console.log('  2. Put Nestbox directly in the workspace');
  console.log('     Writes docker-compose.yaml, docker/, home/, and tests/ into the selected directory.');

  while (true) {
    const answer = (await rl.question('Choose layout [1]: ')).trim().toLowerCase();
    if (!answer || answer === '1' || answer === 'nestbox' || answer === '.nestbox') return 'nestbox';
    if (answer === '2' || answer === 'current' || answer === 'direct') return 'current';
    console.log('Please choose 1 for .nestbox or 2 for direct install.');
  }
}

async function confirmCreation(rl, yes, workspaceDir, installDir, layout) {
  console.log('\nReview');
  console.log(`  Workspace:    ${workspaceDir}`);
  console.log(`  Nestbox files: ${installDir}`);
  console.log(`  Layout:       ${layout === 'nestbox' ? 'workspace/.nestbox' : 'directly in workspace'}`);
  console.log('  Creates:      .env, home/configs/opencode/instance.md');
  console.log('  Does not:     start Docker or collect provider secrets');

  if (yes) return;

  const answer = (await rl.question('\nCreate Nestbox here? [y/N]: ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    throw new Error('Cancelled. No files were created.');
  }
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
  const envPath = join(installDir, '.env');
  const workspaceValue = layout === 'nestbox' ? '..' : '.';
  const configuredEnv = (await readFile(envPath, 'utf8')).replace(/^WORKSPACE_PATH=.*$/m, `WORKSPACE_PATH=${workspaceValue}`);
  await writeFile(envPath, configuredEnv, 'utf8');

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

function hostScripts(layout) {
  const prefix = layout === 'nestbox' ? '.nestbox/' : '';
  return {
    host: `node ${prefix}host-runner.mjs`,
    'test:host': `node ${prefix}tests/host-runner.mjs`
  };
}

async function readWorkspacePackage(workspaceDir) {
  const path = join(workspaceDir, 'package.json');
  if (!(await pathExists(path))) return null;
  let document;
  try {
    document = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot use workspace package.json: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Workspace package.json must contain a JSON object.');
  }
  if (document.scripts !== undefined && (!document.scripts || typeof document.scripts !== 'object' || Array.isArray(document.scripts))) {
    throw new Error('Workspace package.json scripts must be an object.');
  }
  return document;
}

async function preflightHostPackage(workspaceDir, layout) {
  const document = await readWorkspacePackage(workspaceDir);
  if (!document) return;
  for (const [name, command] of Object.entries(hostScripts(layout))) {
    if (document.scripts?.[name] !== undefined && document.scripts[name] !== command) {
      throw new Error(`Refusing to overwrite existing workspace npm script: ${name}`);
    }
  }
}

async function configureHostPackage(installDir, workspaceDir, layout) {
  const scripts = hostScripts(layout);
  const document = await readWorkspacePackage(workspaceDir) || {
    name: 'nestbox-workspace',
    private: true
  };
  document.scripts = { ...(document.scripts || {}), ...scripts };
  await writeFile(join(workspaceDir, 'package.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await writeFile(join(installDir, 'package.host.json'), `${JSON.stringify({
    name: 'nestbox-workspace',
    private: true,
    scripts
  }, null, 2)}\n`, 'utf8');
  const stateBase = process.env.NESTBOX_CREATOR_STATE_ROOT
    || process.env.LOCALAPPDATA
    || process.env.XDG_STATE_HOME
    || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.local', 'state'));
  const queue = join(stateBase, 'nestbox', 'host-runner', randomUUID());
  await mkdir(queue, { recursive: true });
  const runtime = join(installDir, '.runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'host-runner.json'), `${JSON.stringify({ queue }, null, 2)}\n`, 'utf8');
  const envPath = join(installDir, '.env');
  const composeQueue = queue.replaceAll('\\', '/');
  const configuredEnv = (await readFile(envPath, 'utf8')).replace(/^NESTBOX_HOST_QUEUE_PATH=.*$/m, () => `NESTBOX_HOST_QUEUE_PATH=${composeQueue}`);
  await writeFile(envPath, configuredEnv, 'utf8');
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function initGit(installDir) {
  if (!commandExists('git')) return false;
  const result = spawnSync('git', ['init'], { cwd: installDir, stdio: 'inherit' });
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
    printBanner();

    const targetInput = options.target || await ask('Workspace directory', '.', rl, options.yes);
    const layoutInput = options.layout || await askLayout(rl, options.yes);
    validateLayout(layoutInput);

    const workspaceDir = resolve(process.cwd(), targetInput);
    const installDir = layoutInput === 'nestbox' ? join(workspaceDir, '.nestbox') : workspaceDir;

    await confirmCreation(rl, options.yes, workspaceDir, installDir, layoutInput);

    if (!(await isDirectoryEmpty(installDir))) {
      throw new Error(`Refusing to overwrite non-empty installation target: ${installDir}`);
    }

    await preflightHostPackage(workspaceDir, layoutInput);

    await mkdir(installDir, { recursive: true });
    await copyTemplate(installDir);
    await configureInstance(installDir, workspaceDir, layoutInput);
    await configureHostPackage(installDir, workspaceDir, layoutInput);
    const gitInitialized = options.git ? initGit(installDir) : false;

    console.log('\nNestbox project created.');
    console.log(`Installation: ${installDir}`);
    console.log(`Workspace: ${workspaceDir}`);
    console.log(`Git initialized: ${gitInitialized ? 'yes' : 'no'}`);
    console.log('\nNext steps:');
    console.log(`  cd ${workspaceDir}`);
    console.log('  npm run host --');
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
