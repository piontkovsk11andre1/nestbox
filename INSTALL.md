# Agent Installation Guide

Follow this protocol when installing Nestbox into a selected directory or at `<workspace>/.nestbox`.

## Npm Creator

For ordinary new projects, prefer the npm creator:

```sh
npm create @p10i/nestbox@latest
```

The published npm package is `@p10i/create-nestbox`; npm maps `npm create @p10i/nestbox` to that package. The creator scaffolds one of the two default layouts, copies `.env.example` to `.env`, copies `home/configs/opencode/instance.example.md` to `instance.md`, records npm package provenance in the instance policy, and initializes fresh installation Git history when Git is available.

The creator does not start Docker or collect secrets. After it finishes, edit `.env`, then run from the installation directory:

```sh
docker compose config --quiet
docker compose up -d --build
```

Then run the host test suite documented in section 7.

## 1. Choose Language

Before technical questions, ask which language to use for installation communication. Then distinguish three independent choices:

- agent communication only in that language;
- a translated Nestbox interface;
- an extensible i18n setup for multiple interface languages.

Record the communication and interface choices in `home/configs/opencode/instance.md`. Nestbox source is English by default. Translation and i18n are feature work for the internal OpenCode agent after basic startup, not a reason for the external installer to maintain a second implementation path.

## 2. Choose One Default Layout

Resolve and report the absolute selected directory. Offer exactly two defaults:

1. **Current directory:** install Nestbox directly into the selected directory, then initialize fresh installation history at `<selected>/.git`.
2. **`.nestbox`:** treat the selected directory as the workspace, install Nestbox at `<workspace>/.nestbox`, then initialize fresh installation history at `<workspace>/.nestbox/.git`.

Both defaults keep pages, Compose, Dockerfiles, configuration, dependencies, and documentation in the same fresh installation repository. Pages remain under the installation's `home/code`. Upstream Nestbox commit history is not imported into the user's installation history.

Do not present vendoring, a parent-owned engine, a submodule, an external page tree, or another shared-repository arrangement as a default. These are optional adaptations discussed only when the user requests one.

Never overwrite an existing installation. Inspect an existing target and ask whether to update, repair, reuse, or stop.

## 3. Check Requirements And Git

Run:

```sh
git --version
docker version
docker compose version
```

Nestbox requires Git, a running Docker Engine, and Docker Compose v2. If something is missing, explain the platform-specific requirement and pause. Do not install system software without approval.

Inspect Git status for the selected directory and installation target before changing files. Preserve unrelated changes. The fresh Nestbox repository remains independent in both default layouts, including when `.nestbox` is nested inside another Git workspace.

If the `.nestbox` target is inside another Git repository, ask whether to exclude `.nestbox/` through that repository's local `.git/info/exclude` or tracked `.gitignore`. Do not modify the parent repository without approval.

## 4. Create The Installation

For the current-directory layout, shallow-clone the source into the selected empty directory:

```sh
git clone --depth 1 https://github.com/piontkovsk11andre1/nestbox .
```

For the `.nestbox` layout, run from the confirmed workspace:

```sh
git clone --depth 1 https://github.com/piontkovsk11andre1/nestbox .nestbox
```

Immediately after cloning:

1. Resolve and record the source revision with `git rev-parse HEAD` from the clone.
2. Remove only the `.git` directory created by this new clone. Never remove Git metadata from a pre-existing path.
3. Run `git init` in the installation directory.
4. Continue configuration and verification before creating the installation baseline commit.

The resulting `.git` contains only this installation's history. Keeping upstream history or adding an upstream remote is an optional adaptation, not a default.

## 5. Configure The Instance

Copy `.env.example` to `.env` and `home/configs/opencode/instance.example.md` to `home/configs/opencode/instance.md` in the installation directory. Both defaults use the installation's `./home/code` page tree. Configure the workspace mount as follows:

| Layout | `WORKSPACE_PATH` |
| --- | --- |
| Current directory | `.` |
| `<workspace>/.nestbox` | `..` |

Relative bind paths resolve from the installation directory. The page tree is mounted as `/home/code` in runtime services and as the writable `/nestbox/home/code` agent path. `WORKSPACE_PATH` is mounted as `/workspace` in PHP and OpenCode. `NESTBOX_PAGE_PATH` remains an optional advanced override for a user-requested external page tree.

Update the new `home/configs/opencode/instance.md` with:

- the communication language;
- interface language or requested i18n direction;
- installation and workspace paths;
- the Nestbox Git root;
- the recorded upstream source revision;
- whether verified Nestbox changes are committed automatically, require per-commit confirmation, or remain uncommitted.

This is agent guidance and belongs in `instance.md`, not `.env`.

Then ask about:

- a unique lowercase `COMPOSE_PROJECT_NAME`;
- whether to use default port `4180`; verify availability and ask before choosing another port;
- loopback-only or network access;
- OpenCode username and password;
- AI providers;
- Linux UID and GID when bind-mount ownership matters;
- additional directories required by PHP and OpenCode;
- an optional reverse-proxy URL prefix;
- rolling or pinned container images;
- `NESTBOX_OPENCODE_PUBLIC_URL` when `agent.<nestbox-host>` cannot be derived.

Open `.env` in a local editor for runtime settings and secrets. Never ask the user to paste provider keys into chat or print the completed file.

Before startup, query existing Docker containers with the proposed Compose project label. Reject the name if an existing container belongs to another Compose working directory or uses a service not defined by this installation. Do not remove foreign containers or volumes automatically.

For additional directories, mount the same host path at the same container path in PHP and OpenCode. Extend OpenCode's `external_directory` permission when unattended access is intended. Prefer read-only mounts unless writing is required.

Keep PHP-FPM and OpenCode's PHP CLI on the same PHP version. For a path-prefixed reverse proxy, the outer proxy removes the prefix before forwarding and configures `NESTBOX_URL_PREFIX`. Set `NESTBOX_OPENCODE_PUBLIC_URL` explicitly whenever the public OpenCode scheme or host differs from direct Nestbox access.

## 6. Keep The Public Page Tree Empty

The installation already contains Nestbox support files in `home/code`: `404.php`, protected includes and templates, browser sources, and generated asset baselines. Do not create `index.php` or another public project page.

Opening `/` must retain HTTP 404 and render the form that starts an OpenCode session for the first screen. Any route segment beginning with `__` remains private over HTTP and through the CLI router.

## 7. Start And Verify

Run from the installation directory:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose port nginx 80
```

Verify:

- `/` retains HTTP 404 and renders the OpenCode implementation form;
- `/__templates/super-document` returns 404;
- `php /sources/php/cli.php __templates/super-document` is rejected;
- `/Agent` redirects to OpenCode on the same published port;
- the actual OpenCode URL works in the user's client;
- a provider and model are available for agent work, without printing credentials or sending a billable prompt unless the user approves it;
- `/_nestbox/health` returns HTTP 200;
- a transient PHP event reaches an EventSource subscriber through Nchan;
- every `__data` directory remains inaccessible over HTTP;
- no service repeatedly restarts.

Compare the resolved Compose bind sources with the running containers after startup. Recreate a service when its actual mounts do not match the current Compose model; do not claim a path change is active merely because `docker compose config` is valid.

Run the host test suite:

```sh
bash tests/nestbox.sh
```

```powershell
.\tests\nestbox.ps1
```

The scripts support both the fresh 404-first tree and later installations with `index.php`. `--start` for Bash and `-Start` for PowerShell may build and start application services first. Lifecycle mode never runs `down`, removes volumes, or starts an absent Rollup watcher that could rewrite bundles.

Some clients resolve `.localhost` internally even when an operating-system DNS query does not. Test the actual OpenCode URL. If it fails to resolve, ask before adding this hosts-file entry:

```text
127.0.0.1 agent.localhost
```

For another device, configure explicit names for both Nestbox and OpenCode instead of relying on `agent.localhost`.

## 8. Integrate The Host Agent

Before handoff, register this Nestbox location with the external installation agent so future host-maintenance requests resolve the correct installation through the agent's own integration mechanism.

Use the best integration mechanism supported by that agent, in this order:

1. a project-local or user-local agent skill;
2. an agent-native project command, workspace integration, plugin, or configuration entry;
3. a small start/status/maintenance script that invokes the agent with the required context.

The integration must record or supply:

- the absolute installation, workspace, and Git-root paths;
- the Nestbox and OpenCode URLs;
- the selected communication language;
- the path to this `INSTALL.md` and `home/configs/opencode/instructions.md`;
- that page, feature, translation, package, service, and integration work belongs to the internal OpenCode agent;
- that the external agent handles installation, repair, operating-system integration, and host-side Compose validation and activation;
- the recorded commit behavior and repository boundary;
- the normal host test command.

Do not put `.env` contents, credentials, provider keys, or passwords into the integration. Prefer project-local scope. Ask before modifying global agent configuration, user-wide skills, shell profiles, or operating-system paths.

Verify that the resulting skill, command, or script can identify this exact installation and state its maintenance boundary. Report what was created and where. If the current agent cannot persist an integration, provide the user with the exact reusable prompt or command needed to restore this context later.

## 9. Handoff And Extension Request

Report:

- Nestbox and OpenCode URLs without credentials;
- installation, workspace, and Git-root paths;
- selected communication and interface language;
- commit behavior;
- remaining uncommitted changes.

Ask the user to open OpenCode. Then ask what they want to change or extend in Nestbox. Typical requests include:

- creating the first screen or another super-document;
- translating the interface or adding i18n;
- integrating a Python program, database, worker, native tool, or host service;
- installing browser, PHP, system, or agent-toolchain packages;
- adding mounts, networks, proxy routes, or persistent volumes.

Send this work to the internal OpenCode agent. A useful prompt is:

```text
Extend this Nestbox installation for the following requirement: <request>. Inspect /workspace and /nestbox, follow the internal Nestbox manual, implement and verify all file changes you can, and report the exact host-side activation command for any container or infrastructure change.
```

The internal agent edits pages and infrastructure definitions. It has no Docker socket and must not claim host activation. The external maintainer resumes only to inspect the proposed infrastructure files, run `docker compose config`, apply the narrowest build or recreate operation, and verify health.

## 10. Git And Generated State

The fresh Git root is the installation's `.git` in current-directory mode or `.nestbox/.git` in `.nestbox` mode. It owns reasonable Nestbox source changes, including:

- super-documents and selected durable `__data` files explicitly opted into Git history;
- reusable helpers and browser source;
- generated browser bundle baselines, which keep the initial interface available before the watcher starts;
- Compose files and Dockerfiles;
- Nginx, PHP, Rollup, and OpenCode configuration;
- portable integration definitions and dependency lockfiles;
- documentation and translation resources.

Follow the commit behavior recorded in `instance.md`:

- automatic: create a focused commit after verification;
- confirmation: show the exact paths and ask before each commit;
- no-commit: leave changes uncommitted.

After basic verification, create or offer one focused baseline commit containing the installed source and non-secret instance configuration. A concise default message is `Initialize Nestbox`. If the selected policy requires confirmation or forbids commits, leave the baseline pending and report that clearly.

Stage exact intended files only. Preserve unrelated changes. Never commit `.env`, provider credentials, caches, incidental state, or unrelated project files. Never amend, change Git configuration, discard changes, or push without explicit approval.

When a super-document intentionally changes files in `/workspace`, follow that workspace repository's own policy separately.

## 11. Optional Adaptations

Retaining upstream Git history, adding an upstream remote, external page trees, parent-owned engines, submodules, vendoring, shared repositories, alternate Compose layouts, and operating-system shortcuts are optional. Explain their ownership and update consequences and obtain explicit confirmation before creating them. They must not obscure the two default installation paths.
