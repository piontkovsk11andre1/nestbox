# Changelog

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
