# Nestbox

## Introduction

Nestbox is an agent-guided workspace for building focused interfaces around projects, tools, data, and containerized services.

Its core design is the **super-document**: one cohesive PHP and Markdown document can provide server logic, command-line behavior, forms, HTML, and browser JavaScript. The internal OpenCode agent creates and extends these documents, integrates project runtimes, and prepares infrastructure changes.

Nestbox runs with Docker Compose using Nginx, PHP-FPM, Rollup, OpenCode, and a private control service. A fresh installation opens with a prompt for creating its first screen instead of shipping a predefined application.

## Container And Host Control

The `control` service is the only container with `/var/run/docker.sock`. Its internal-only API permits exec only when caller, target, project, and root-user labels allow it. OpenCode reaches the API through the bundled control MCP and can target PHP-FPM and Rollup by default. Trusted PHP pages can use `nestbox_control_exec()` and are restricted to PHP-FPM self-exec.

Native host commands are limited to scripts already declared in the workspace `package.json`. Keep `npm run host --` running from the workspace when host scripts are needed. The native runner authenticates with an external token file mounted only into `control`, long-polls `/_nestbox/host/` through the shared Nginx gateway port, and posts results; no host server, second published port, or shared filesystem queue is used. MCP can request script additions, edits, or deletions, but the host runner applies them only after the user supplies a short-lived code displayed exclusively in the host terminal.

Control emits bounded structured events to ordinary container logs. Use `docker compose logs control`; no telemetry collector, database, or observability dependency is installed. Docker socket access is root-equivalent on the host, and host scripts execute in the trusted writable workspace, so neither mechanism is a sandbox.

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

The creator previews the exact paths before it writes files. The recommended layout installs Nestbox at `<workspace>/.nestbox` so Nestbox stays separate from your project files. You can also choose a direct install into an empty directory. It creates a minimal workspace `package.json` when absent or safely merges non-conflicting `host` and `test:host` scripts into an existing manifest. After creation, edit `.env`, start `npm run host --`, then run the Docker Compose validation and startup commands printed by the creator.

For agent-guided installation or repair work, copy and send this to an agent with filesystem, Git, Docker, and terminal access:

```text
Install Nestbox by following https://github.com/piontkovsk11andre1/nestbox/blob/main/INSTALL.md completely. Ask all required questions before making changes, preserve unrelated files and Git history, and do not expose secrets.
```
