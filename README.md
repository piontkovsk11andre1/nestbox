# Nestbox

## Introduction

Nestbox is an agent-guided workspace for building focused interfaces around projects, tools, data, and containerized services.

Its core design is the **super-document**: one cohesive PHP and Markdown document can provide server logic, command-line behavior, forms, HTML, and browser JavaScript. The internal OpenCode agent creates and extends these documents, integrates project runtimes, and prepares infrastructure changes.

Nestbox runs with Docker Compose using Nginx, PHP-FPM, Rollup, OpenCode, and a private control service. A fresh installation opens with a prompt for creating its first screen instead of shipping a predefined application.

## Container Control

The `control` service is the only container with `/var/run/docker.sock`. Its internal-only API permits exec only when caller, target, project, and root-user labels allow it. OpenCode reaches the API through the bundled control MCP and can target PHP-FPM and Rollup by default. Trusted PHP pages can use `nestbox_control_exec()` and are restricted to PHP-FPM self-exec.

Project commands run inside the appropriate container through `docker_exec`. Host-side Docker Compose activation is performed by the user or external maintainer. Nestbox needs no background process on the host and no workspace `package.json`.

Control emits bounded structured events to ordinary container logs. Use `docker compose logs control`; no telemetry collector, database, or observability dependency is installed. Docker socket access is root-equivalent on the host, so this is a controlled capability, not a sandbox.

## Runtime Versions And Updates

Nestbox tracks the latest stable container images by default: OpenCode and Composer use `latest`, Alpine uses `latest`, and Node, Python, and PHP use their rolling Alpine variants. Alpine-installed tools use the newest packages available in the base image's configured repositories; OpenCode's PHP CLI selects the newest available PHP branch. These repositories can lag upstream releases, so verify the resulting PHP CLI and FPM versions after a refresh.

Refresh images and installed system packages from the installation directory:

```sh
docker compose config --quiet
docker compose build --pull --no-cache
docker compose up -d
docker compose exec -T php-fpm php --version
docker compose exec -T opencode php --version
```

Reconnect to OpenCode after recreation, then run `bash tests/nestbox.sh` or `.\tests\nestbox.ps1`. Existing containers do not update automatically. JavaScript and PHP library dependencies continue to use their committed lockfiles; runtime refreshes do not rewrite those dependencies.

## Learn More

Copy and send this to an agent with web access:

```text
Learn about Nestbox from https://github.com/piontkovsk11andre1/nestbox. Read its current documentation and explain its super-document design, agent workflow, container integration model, best use cases, and limitations. Do not install or modify anything.
```

## Installation

Create a new Nestbox project with npm:

```sh
npm create @p10i/nestbox@latest
```

The creator previews the exact paths before it writes files. The recommended layout installs Nestbox at `<workspace>/.nestbox` so Nestbox stays separate from your project files. You can also choose a direct install into an empty directory. The workspace's package manifest is left untouched. After creation, edit `.env`, then run the Docker Compose validation and startup commands printed by the creator. Node.js and npm are needed only to use the creator; the installed runtime runs entirely in Docker.

For upgrades from versions with host npm execution, see the migration notes in [INSTALL.md](INSTALL.md#upgrading-from-host-runner-versions).

For agent-guided installation or repair work, copy and send this to an agent with filesystem, Git, Docker, and terminal access:

```text
Install Nestbox by following https://github.com/piontkovsk11andre1/nestbox/blob/main/INSTALL.md completely. Ask all required questions before making changes, preserve unrelated files and Git history, and do not expose secrets.
```
