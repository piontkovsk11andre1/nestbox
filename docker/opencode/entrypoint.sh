#!/bin/sh
set -eu

# Named volumes retain ownership across image recreation. Repair only OpenCode's
# private state volume before dropping privileges; never chown host bind mounts.
mkdir -p "$HOME/.local/share/opencode"
chown -R nestbox:nestbox "$HOME/.local/share/opencode"

exec su-exec nestbox:nestbox opencode "$@"
