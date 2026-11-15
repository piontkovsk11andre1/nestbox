# Changelog

## 0.7.0

- Include do-md as a default internal service and configure OpenCode's do-md MCP for remote HTTP execution.
- Share workspace and page files through `/documents/workspace` and `/documents/pages` in PHP, OpenCode, and do-md, including external page-tree overrides.
- Install `@p10i/do-md@latest` in the backend and proxy images, with build/API compatibility checks, matched runtime ownership, health dependencies, and no additional published port.
- Add bounded, non-retrying PHP HTTP helpers for all eight document/reference operations, health, and capabilities.
- Add real PHP/HTTP/MCP publisher tests and shared-mount checks to both host smoke suites; document activation and the default 20-second deadline.

## 0.6.0

- Consistently track latest-stable runtime images, dynamically select Alpine's newest PHP CLI branch, and document fresh builds with `--pull --no-cache`.
- Remove native host npm execution, npm script confirmation tools, the host runner, its stdio bridge, and the loopback job API. Keep label-gated container execution and structured control logs.
- Stop creating or modifying workspace package manifests during installation. Remove package.json-specific bind mounts and the control service's workspace mount.
- Run the installed runtime entirely in Docker; host Node.js is needed only when using the npm creator.
- Load OpenCode instructions and instance policy by absolute `/etc/opencode` paths, incorporating Gitea fix `4d53e89`.
- See `INSTALL.md` for existing-installation cleanup and activation steps.

## 0.5.0

- Replace the public token-authenticated host API with a persistent `docker compose exec -T control` stdio bridge.
- Bind the bridge API to container loopback and add reconnect-safe runner sessions with idempotent result replay.
- Remove host tokens, the Nginx host proxy, and all `4089` exposure while retaining one Nginx-published host port.
- Existing `0.3.x` and `0.4.x` installations may remove `NESTBOX_HOST_TOKEN_FILE` and its referenced token file after upgrading.

## 0.4.0

- Route the authenticated host runner through `/_nestbox/host/` on the existing Nginx gateway.
- Restore the one-Nestbox, one-published-port invariant while keeping the control APIs private.

## 0.3.0

- Replace the filesystem host queue with authenticated HTTP long polling managed by `control`.
- Publish only the dedicated host-runner endpoint on loopback; keep the container API internal.
- Remove queue paths, bind mounts, polling files, and stale lock/result state.
- Generate a per-installation runner token file unavailable to application containers and preserve existing MCP and PHP contracts.

## 0.2.0

- Add a private, label-gated container control service and OpenCode MCP adapter.
- Add native host npm execution through a filesystem bridge with no network listener.
- Add host-confirmed npm script creation, editing, and deletion.
- Add reusable PHP control helpers and restrict PHP to self-exec by default.
- Support both `.nestbox` and direct creator layouts with safe workspace manifest merging.
- Add bounded structured control logs without introducing an observability dependency.
