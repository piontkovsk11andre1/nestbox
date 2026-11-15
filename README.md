# Nestbox

## Introduction

Nestbox is an agent-guided workspace for building focused interfaces around projects, tools, data, and containerized services.

Its core design is the **super-document**: one cohesive PHP and Markdown document can provide server logic, command-line behavior, forms, HTML, and browser JavaScript. The internal OpenCode agent creates and extends these documents, integrates project runtimes, and prepares infrastructure changes.

Nestbox runs with Docker Compose using Nginx, PHP-FPM, Rollup, OpenCode, a private control service, and a shared do-md document service. A fresh installation opens with a prompt for creating its first screen instead of shipping a predefined application.

## Container Control

The `control` service is the only container with `/var/run/docker.sock`. Its internal-only API permits exec only when caller, target, project, and root-user labels allow it. OpenCode reaches the API through the bundled control MCP and can target PHP-FPM and Rollup by default. Trusted PHP pages can use `nestbox_control_exec()` and are restricted to PHP-FPM self-exec.

Project commands run inside the appropriate container through `docker_exec`. Host-side Docker Compose activation is performed by the user or external maintainer. Nestbox needs no background process on the host and no workspace `package.json`.

Control emits bounded structured events to ordinary container logs. Use `docker compose logs control`; no telemetry collector, database, or observability dependency is installed. Docker socket access is root-equivalent on the host, so this is a controlled capability, not a sandbox.

## Runtime Versions And Updates

The do-md service and OpenCode image install `@p10i/do-md@latest` during builds. Package checks require do-md 1.4.0 or newer with HTTP API v1 and all eight document/reference operations. OpenCode runs its stdio MCP proxy in remote-dispatch mode; execution happens in the do-md service, without a host npm runner.

Nestbox tracks the latest stable container images by default: OpenCode and Composer use `latest`, Alpine uses `latest`, and Node, Python, and PHP use their rolling Alpine variants. Alpine-installed tools use the newest packages available in the base image's configured repositories; OpenCode's PHP CLI selects the newest available PHP branch. These repositories can lag upstream releases, so verify the resulting PHP CLI and FPM versions after a refresh.

Refresh images and installed system packages from the installation directory:

```sh
docker compose config --quiet
docker compose build --pull --no-cache
docker compose up -d
docker compose exec -T php-fpm php --version
docker compose exec -T opencode php --version
```

Reconnect to OpenCode after recreation, then run `bash tests/nestbox.sh` or `.\tests\nestbox.ps1`. Existing containers do not update automatically. Application JavaScript and PHP library dependencies continue to use their committed lockfiles; the explicitly rolling do-md tool installation is refreshed at image build time.

## Shared Markdown Tools

The default `do-md` MCP supports `validate`, `export`, `create`, `set`, `render`, `match`, `query`, and `reference`. Its reference resources describe the executing remote version. PHP calls the same backend at `http://do-md:8080`; the API is internal-only and has no Nginx route or published host port.

PHP-FPM, OpenCode, and do-md share these writable aliases in both installation layouts:

| Path | Contents |
| --- | --- |
| `/documents/workspace` | The same host workspace as `/workspace` |
| `/documents/pages` | The page tree selected by `NESTBOX_PAGE_PATH`, including external overrides |

The server root is `/documents`. MCP file arguments can use `workspace/project/notes.md` or `pages/report.md`; PHP can select a narrower directory and use relative names. Existing `/workspace`, `/home/code`, and `/nestbox/home/code` paths keep their normal purpose. There is no file copy or synchronization step.

Shared PHP helpers are loaded automatically in super-documents:

```php
$result = nestbox_do_md_export(
    ['file' => 'notes.md', 'template' => 'notes.tpl.md'],
    directory: '/documents/workspace/project',
);
if ($result['ok']) {
    $context = $result['context'];
}
```

The default set is `nestbox_do_md_validate`, `nestbox_do_md_export`, `nestbox_do_md_create`, `nestbox_do_md_set`, `nestbox_do_md_render`, `nestbox_do_md_match`, `nestbox_do_md_query`, and `nestbox_do_md_reference`. Each accepts `(array $params, string $directory = '/documents/workspace', array $limits = [])`; reference also defaults to empty params. Parameter names match the do-md API, including inline `data`/`patch` objects, `savePath`, and `dryRun`.

`nestbox_do_md($command, $params, $directory, $limits)` is the generic operation helper. `nestbox_do_md_health()` and `nestbox_do_md_capabilities()` inspect the service, and `nestbox_do_md_request()` returns `['status' => ..., 'body' => ...]` for bounded low-level requests. Operation helpers return structured command failures, including HTTP deadline/busy diagnostics; network failures and invalid responses throw. Requests are never automatically retried because a write may already have committed.

The default execution deadline is 20 seconds (`NESTBOX_DO_MD_TIMEOUT_MS`), with five seconds of HTTP transport grace. Requests are bounded to 1 MiB, responses to 8 MiB, and do-md defaults to four concurrent calls. Root, symlink, and output-path checks are enforced by do-md. Templates remain trusted JavaScript; use existing page CSRF protection for browser-triggered mutations. The service runs as the configured UID/GID, persists only shared files, and publishes no Nestbox events itself.

## Source Verification

For package development, use Node 20+, Python 3, and PHP, then run `npm ci`, `npm test`, and `npm run prepack`. The dev-only do-md dependency runs real HTTP/PHP/MCP integration tests; it is not a host runtime requirement. Installed applications use the Bash or PowerShell host smoke suite, which checks actual container mounts, PHP operations, and remote MCP with unique private fixtures that are removed afterward.

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
