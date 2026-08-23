#!/usr/bin/env bash

set -uo pipefail

START=0
TIMEOUT=30
PAGE_ROOT_ARG=""
PASSES=0
FAILURES=0
SKIPS=0

usage() {
    printf 'Usage: %s [--start] [--timeout seconds] [--page-root path]\n' "$0"
}

while (($#)); do
    case "$1" in
        --start)
            START=1
            ;;
        --timeout)
            shift
            TIMEOUT="${1:-}"
            [[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { usage; exit 2; }
            ;;
        --page-root)
            shift
            PAGE_ROOT_ARG="${1:-}"
            [[ -n "$PAGE_ROOT_ARG" ]] || { usage; exit 2; }
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            usage
            exit 2
            ;;
    esac
    shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGE_ROOT="${PAGE_ROOT_ARG:-${NESTBOX_PAGE_PATH:-$ROOT/home/code}}"
if [[ "$PAGE_ROOT" != /* ]]; then
    PAGE_ROOT="$ROOT/$PAGE_ROOT"
fi
if [[ -n "$PAGE_ROOT_ARG" ]]; then
    export NESTBOX_PAGE_PATH="$PAGE_ROOT"
fi
COMPOSE=(docker compose --project-directory "$ROOT")
TEMP_DIR=""
SSE_PID=""

cleanup() {
    if [[ -n "$SSE_PID" ]] && kill -0 "$SSE_PID" 2>/dev/null; then
        kill "$SSE_PID" 2>/dev/null || true
        wait "$SSE_PID" 2>/dev/null || true
    fi
    [[ -z "$TEMP_DIR" ]] || rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

pass() {
    PASSES=$((PASSES + 1))
    printf 'PASS  %s\n' "$1"
}

fail() {
    FAILURES=$((FAILURES + 1))
    printf 'FAIL  %s\n' "$1" >&2
}

skip() {
    SKIPS=$((SKIPS + 1))
    printf 'SKIP  %s\n' "$1"
}

require_command() {
    if command -v "$1" >/dev/null 2>&1; then
        pass "$1 is available"
    else
        fail "$1 is required"
        return 1
    fi
}

compose() {
    "${COMPOSE[@]}" "$@"
}

container_id() {
    compose ps -q "$1" 2>/dev/null
}

container_running() {
    local id
    id="$(container_id "$1")"
    [[ -n "$id" ]] && [[ "$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null)" == "true" ]]
}

restart_count() {
    local id
    id="$(container_id "$1")"
    [[ -n "$id" ]] || return 1
    docker inspect --format '{{.RestartCount}}' "$id" 2>/dev/null
}

http_request() {
    local path="$1"
    local host_header="${2:-}"
    local method="${3:-GET}"
    local body_file="$TEMP_DIR/body"
    local header_file="$TEMP_DIR/headers"
    local args=(--silent --show-error --noproxy '*' --max-time "$TIMEOUT" --request "$method" --output "$body_file" --dump-header "$header_file" --write-out '%{http_code}')
    [[ -z "$host_header" ]] || args+=(--header "Host: $host_header")
    curl "${args[@]}" "$BASE_URL$path"
}

header_value() {
    local name="$1"
    local wanted
    wanted="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]'):"
    awk -v wanted="$wanted" '
        { line=$0; sub(/\r$/, "", line); lower=tolower(line) }
        index(lower, wanted) == 1 { sub(/^[^:]*:[[:space:]]*/, "", line); value=line }
        END { print value }
    ' "$TEMP_DIR/headers"
}

if ! require_command docker || ! require_command curl; then
    printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILURES" "$SKIPS"
    exit 1
fi

if docker compose version >/dev/null 2>&1; then
    pass 'Docker Compose v2 is available'
else
    fail 'Docker Compose v2 is required'
    exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nestbox-test.XXXXXX")"
configured_queue="$(sed -n 's/^NESTBOX_HOST_QUEUE_PATH=//p' "$ROOT/.env" | tail -n 1)"
if [[ -z "${NESTBOX_HOST_QUEUE_PATH:-}" && -z "$configured_queue" ]]; then
    export NESTBOX_HOST_QUEUE_PATH="$TEMP_DIR/host-runner"
fi
if [[ -n "${NESTBOX_HOST_QUEUE_PATH:-}" ]]; then mkdir -p "$NESTBOX_HOST_QUEUE_PATH"; fi

[[ -f "$ROOT/.env" ]] && pass '.env exists' || fail '.env is missing'
[[ ! -d "$ROOT/home/.git" ]] && pass 'Page and configuration tree has no embedded Git repository' || fail 'home/.git must not be included in an installation'
if [[ -f "$PAGE_ROOT/index.php" ]]; then
    INDEX_PRESENT=1
    pass 'Page tree has an implemented index.php'
else
    INDEX_PRESENT=0
    pass 'Fresh page tree intentionally has no index.php'
fi
grep -Fq 'free of empty lines between its nested or adjacent element tags' "$ROOT/home/configs/opencode/instructions.md" && pass 'OpenCode instructions enforce contiguous raw HTML blocks' || fail 'OpenCode instructions omit the raw HTML blank-line invariant'
grep -Fq '## PHP To OpenCode API' "$ROOT/home/configs/opencode/instructions.md" && pass 'OpenCode instructions document the PHP API' || fail 'OpenCode instructions omit the PHP API contract'
grep -Fq '## Extending The Environment' "$ROOT/home/configs/opencode/instructions.md" && pass 'OpenCode instructions document environment extension' || fail 'OpenCode instructions omit environment extension guidance'
grep -Fq 'deliberately has no Docker socket' "$ROOT/home/configs/opencode/instructions.md" && pass 'OpenCode instructions preserve the host container boundary' || fail 'OpenCode instructions omit the host container boundary'
[[ -f "$ROOT/home/configs/opencode/instance.example.md" ]] && pass 'OpenCode instance policy template exists' || fail 'OpenCode instance policy template is missing'
[[ -f "$ROOT/home/configs/opencode/instance.md" ]] && pass 'Installed OpenCode instance policy exists' || fail 'Copy instance.example.md to instance.md before startup'
grep -Fq 'Commit policy:' "$ROOT/home/configs/opencode/instance.md" && pass 'OpenCode instance policy records commit behavior' || fail 'OpenCode instance policy omits commit behavior'
grep -Fq 'Communication language:' "$ROOT/home/configs/opencode/instance.md" && pass 'OpenCode instance policy records communication language' || fail 'OpenCode instance policy omits communication language'
grep -Fq '"instance.md"' "$ROOT/home/configs/opencode/opencode.json" && pass 'OpenCode loads instance policy directly' || fail 'OpenCode does not load instance policy'
grep -Fq '"control"' "$ROOT/home/configs/opencode/opencode.json" && pass 'OpenCode registers the control MCP' || fail 'OpenCode does not register the control MCP'
[[ -f "$ROOT/docker/control/server.py" && -f "$ROOT/host-runner.mjs" ]] && pass 'Control and host runner sources exist' || fail 'Control or host runner source is missing'

if compose config --quiet; then
    pass 'Compose configuration is valid'
else
    fail 'Compose configuration is invalid'
fi

services="$(compose config --services 2>/dev/null || true)"
for service in nginx php-fpm rollup control opencode; do
    if grep -qx "$service" <<<"$services"; then
        pass "Compose defines $service"
    else
        fail "Compose does not define $service"
    fi
done
running_services="$(compose ps --services 2>/dev/null || true)"
while IFS= read -r service; do
    [[ -z "$service" ]] && continue
    if ! grep -qx "$service" <<<"$services"; then
        fail "Compose project contains unexpected service $service; choose a unique COMPOSE_PROJECT_NAME"
    fi
done <<<"$running_services"

if ((START)); then
    if compose build nginx php-fpm rollup control opencode; then
        pass 'All service images build'
    else
        fail 'One or more service images failed to build'
    fi

    # The Rollup watcher intentionally writes generated bundles to the bind
    # mount, so lifecycle mode leaves it untouched and validates its image via
    # the build plus the bundles served by Nginx.
    if compose up -d nginx php-fpm control opencode; then
        pass 'Application services started'
    else
        fail 'Application services failed to start'
    fi
fi

for service in nginx php-fpm control opencode; do
    if container_running "$service"; then
        pass "$service is running"
    else
        fail "$service is not running"
    fi
done

if [[ -n "$(container_id rollup)" ]]; then
    container_running rollup && pass 'rollup is running' || fail 'rollup exists but is not running'
else
    skip 'rollup watcher is not running; generated bundles are tested from the image'
fi

NGINX_RESTARTS="$(restart_count nginx 2>/dev/null || printf '')"
PHP_RESTARTS="$(restart_count php-fpm 2>/dev/null || printf '')"
OPENCODE_RESTARTS="$(restart_count opencode 2>/dev/null || printf '')"
CONTROL_RESTARTS="$(restart_count control 2>/dev/null || printf '')"

published="$(compose port nginx 80 2>/dev/null || true)"
if [[ "$published" =~ ^\[(.*)\]:([0-9]+)$ ]]; then
    WEB_HOST="${BASH_REMATCH[1]}"
    WEB_PORT="${BASH_REMATCH[2]}"
elif [[ "$published" =~ ^(.*):([0-9]+)$ ]]; then
    WEB_HOST="${BASH_REMATCH[1]}"
    WEB_PORT="${BASH_REMATCH[2]}"
else
    fail 'Could not resolve the published Nginx port'
    printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILURES" "$SKIPS"
    exit 1
fi

case "$WEB_HOST" in
    0.0.0.0|::) WEB_HOST=127.0.0.1 ;;
esac
if [[ "$WEB_HOST" == *:* ]]; then
    BASE_URL="http://[$WEB_HOST]:$WEB_PORT"
else
    BASE_URL="http://$WEB_HOST:$WEB_PORT"
fi
pass "Nginx is published at $BASE_URL"

deadline=$((SECONDS + TIMEOUT))
health_status=000
while ((SECONDS < deadline)); do
    health_status="$(http_request '/_nestbox/health' 2>/dev/null || printf '000')"
    [[ "$health_status" == "200" ]] && break
    sleep 1
done
[[ "$health_status" == "200" ]] && pass 'Nginx and PHP health endpoint responds' || fail 'Health endpoint did not become ready'

compose exec -T nginx nginx -t >/dev/null 2>&1 && pass 'Nginx configuration is valid' || fail 'Nginx configuration is invalid'
compose exec -T nginx apk info -e nginx >/dev/null 2>&1 && pass 'Alpine Nginx package is installed' || fail 'Alpine Nginx package is missing'
compose exec -T nginx apk info -e nginx-mod-http-nchan >/dev/null 2>&1 && pass 'Alpine Nchan package is installed' || fail 'Alpine Nchan package is missing'
nginx_config="$(compose exec -T nginx nginx -T 2>&1 || true)"
if grep -q 'ngx_nchan_module.so' <<<"$nginx_config"; then
    pass 'Nchan dynamic module is loaded'
else
    fail 'Nchan dynamic module is not loaded'
fi

if ((INDEX_PRESENT)); then
    status="$(http_request '/' 2>/dev/null || printf '000')"
    [[ "$status" == "200" ]] && pass 'Main super-document returns HTTP 200' || fail "Main super-document returned HTTP $status"
    content_type="$(header_value 'Content-Type')"
    content_type="$(printf '%s' "$content_type" | tr '[:upper:]' '[:lower:]')"
    [[ "$content_type" == text/html* ]] && pass 'Main super-document is HTML' || fail 'Main super-document has the wrong content type'
else
    status="$(http_request '/' 2>/dev/null || printf '000')"
    if [[ "$status" == "404" ]] && grep -Fq 'Create and open session' "$TEMP_DIR/body"; then
        pass 'Fresh root renders the OpenCode implementation form with HTTP 404'
    else
        fail "Fresh root did not render the OpenCode implementation form with HTTP 404"
    fi
fi
for header in Content-Security-Policy X-Content-Type-Options Referrer-Policy Cache-Control; do
    [[ -n "$(header_value "$header")" ]] && pass "$header is present" || fail "$header is missing"
done
[[ "$(header_value 'Cache-Control')" == *no-store* ]] && pass 'Nestbox responses disable browser caching' || fail 'Nestbox responses permit browser caching'

if ((INDEX_PRESENT)); then
    status="$(http_request '/index.md' 2>/dev/null || printf '000')"
    [[ "$status" == "200" ]] && pass 'Markdown direction returns HTTP 200' || fail "Markdown direction returned HTTP $status"
    content_type="$(header_value 'Content-Type')"
    content_type="$(printf '%s' "$content_type" | tr '[:upper:]' '[:lower:]')"
    [[ "$content_type" == text/markdown* ]] && pass 'Markdown direction has text/markdown content type' || fail 'Markdown direction has the wrong content type'
else
    status="$(http_request '/index.md' 2>/dev/null || printf '000')"
    [[ "$status" == "404" ]] && pass 'Fresh index Markdown direction remains unresolved' || fail "Fresh index Markdown direction returned HTTP $status"
fi

for asset in scripts-bundle.js scripts-bundle.css styles.css; do
    status="$(http_request "/$asset" 2>/dev/null || printf '000')"
    if [[ "$status" == "200" && -s "$TEMP_DIR/body" ]]; then
        pass "$asset is served and nonempty"
    else
        fail "$asset is unavailable or empty"
    fi
    [[ "$(header_value 'Cache-Control')" == *no-store* ]] && pass "$asset disables browser caching" || fail "$asset permits browser caching"
done

for path in /index.php /__templates/super-document /__includes/functions.php /__data/example.json /docs/__data/install.json; do
    status="$(http_request "$path" 2>/dev/null || printf '000')"
    [[ "$status" == "404" ]] && pass "$path is protected" || fail "$path returned HTTP $status instead of 404"
done
status="$(http_request '/.user.ini' 2>/dev/null || printf '000')"
[[ "$status" == "403" || "$status" == "404" ]] && pass 'Dotfiles are protected' || fail "Dotfile returned HTTP $status"

missing_path="/missing-$RANDOM"
missing_uri="$missing_path?view=full"
status="$(http_request "$missing_uri" 2>/dev/null || printf '000')"
if [[ "$status" == "404" ]] && grep -Fq 'Create and open session' "$TEMP_DIR/body"; then
    pass 'Missing routes render the interactive PHP 404 document'
else
    fail 'Missing route did not render the interactive PHP 404 document'
fi
grep -Fq "name=\"requested_uri\" value=\"$missing_uri\"" "$TEMP_DIR/body" && pass 'Interactive 404 preserves the requested page URI' || fail 'Interactive 404 lost the requested page URI'
if grep -Fq 'name="prompt" type="text"' "$TEMP_DIR/body" && grep -Fq 'target="nestbox-opencode"' "$TEMP_DIR/body"; then
    pass 'Interactive 404 uses a one-line prompt and the shared OpenCode window'
else
    fail 'Interactive 404 prompt form has the wrong behavior'
fi
if grep -Fq 'nestbox-toolbar' "$TEMP_DIR/body" && grep -Fq 'Open Chat' "$TEMP_DIR/body" && ! grep -Fq 'Continue in OpenCode' "$TEMP_DIR/body"; then
    pass 'Shared header opens the common OpenCode chat'
else
    fail 'Shared header contains page-specific session controls'
fi
status="$(http_request '/404' '' 'POST' 2>/dev/null || printf '000')"
[[ "$status" == "422" ]] && pass 'Interactive 404 rejects invalid requests' || fail "Interactive 404 accepted an invalid request with HTTP $status"

nginx_id="$(container_id nginx)"
publisher_binding="$(docker inspect --format '{{json (index .NetworkSettings.Ports "8080/tcp")}}' "$nginx_id" 2>/dev/null || true)"
if [[ -z "$publisher_binding" || "$publisher_binding" == "null" ]]; then
    pass 'Internal publisher port is not published on the host'
else
    fail 'Internal publisher port is published on the host'
fi
status="$(http_request '/_nestbox/publish?topics=nestbox-test:public' '' 'POST' 2>/dev/null || printf '000')"
[[ "$status" == "404" ]] && pass 'Publisher endpoint is unavailable on the public port' || fail "Public publisher endpoint returned HTTP $status"

control_id="$(container_id control)"
control_binding="$(docker inspect --format '{{json (index .NetworkSettings.Ports "4088/tcp")}}' "$control_id" 2>/dev/null || true)"
[[ -z "$control_binding" || "$control_binding" == "null" ]] && pass 'Control API is not published on the host' || fail 'Control API is published on the host'
opencode_id="$(container_id opencode)"
opencode_mounts="$(docker inspect --format '{{range .Mounts}}{{println .Source .Destination}}{{end}}' "$opencode_id" 2>/dev/null || true)"
grep -Fq '/var/run/docker.sock' <<<"$opencode_mounts" && fail 'OpenCode receives the Docker socket' || pass 'OpenCode does not receive the Docker socket'
control_mounts="$(docker inspect --format '{{range .Mounts}}{{println .Source .Destination}}{{end}}' "$control_id" 2>/dev/null || true)"
grep -Fq '/var/run/docker.sock' <<<"$control_mounts" && pass 'Control receives the Docker socket' || fail 'Control does not receive the Docker socket'

if ((INDEX_PRESENT)); then
    if compose exec -T php-fpm php -l /home/code/index.php >/dev/null 2>&1; then
        pass 'Installed super-document passes PHP lint'
    else
        fail 'Installed super-document failed PHP lint'
    fi
else
    pass 'Fresh page tree has no index.php to lint'
fi
if compose exec -T php-fpm php -l /home/code/404.php >/dev/null 2>&1; then
    pass 'Interactive 404 super-document passes PHP lint'
else
    fail 'Interactive 404 super-document failed PHP lint'
fi
context_code='require "/home/code/__includes/functions.php"; $context = nestbox_page_context("/docs/install?tab=all"); exit($context["statePath"] === "/home/code/docs/__data/install.json" && $context["agentDirectory"] === "/nestbox/home/code/docs" ? 0 : 1);'
if compose exec -T php-fpm php -r "$context_code" >/dev/null 2>&1; then
    pass 'Nested pages map to directory-local data and agent scope'
else
    fail 'Nested page data or agent context is incorrect'
fi
if compose exec -T php-fpm php /sources/php/cli.php __templates/super-document >/dev/null 2>&1; then
    fail 'Protected super-document executed through the CLI router'
else
    pass 'CLI router rejects protected super-documents'
fi

opencode_health_code='require "/home/code/__includes/functions.php"; $health = nestbox_opencode_request("GET", "/global/health", [], "/workspace"); exit(($health["healthy"] ?? false) ? 0 : 1);'
if compose exec -T php-fpm php -r "$opencode_health_code" >/dev/null 2>&1; then
    pass 'PHP reaches the authenticated internal OpenCode API'
else
    fail 'PHP cannot reach the authenticated internal OpenCode API'
fi

status="$(http_request '/Agent' "localhost:$WEB_PORT" 2>/dev/null || printf '000')"
location="$(header_value 'Location')"
if [[ "$status" == "302" && "$location" == "http://agent.localhost:$WEB_PORT/" ]]; then
    pass '/Agent redirects to the same-port OpenCode origin'
else
    fail "/Agent redirect was HTTP $status with Location $location"
fi

status="$(http_request '/doc' "agent.localhost:$WEB_PORT" 2>/dev/null || printf '000')"
if [[ "$status" == "401" || "$status" =~ ^[23][0-9][0-9]$ ]]; then
    pass 'OpenCode host routing responds'
else
    fail "OpenCode host routing returned HTTP $status"
fi

channel="nestbox-test:$(date +%s)-$$"
token="event-$(date +%s)-$$-$RANDOM"
sse_file="$TEMP_DIR/events"
curl --silent --show-error --noproxy '*' --no-buffer --max-time "$TIMEOUT" \
    --header 'Accept: text/event-stream' \
    "$BASE_URL/_nestbox/events?topics=nestbox-test:*" >"$sse_file" 2>"$TEMP_DIR/events-error" &
SSE_PID=$!
deadline=$((SECONDS + TIMEOUT))
while ((SECONDS < deadline)); do
    grep -Fq ': hi' "$sse_file" 2>/dev/null && break
    sleep 1
done
if grep -Fq ': hi' "$sse_file" 2>/dev/null; then
    pass 'EventSource subscriber is connected'
else
    fail 'EventSource subscriber did not connect'
fi

php_code='require "/home/code/__includes/functions.php"; exit(nestbox_bus_publish(getenv("TEST_TOPIC"), "changed", ["token" => getenv("TEST_TOKEN")]) ? 0 : 1);'
if compose exec -T -e "TEST_TOPIC=$channel" -e "TEST_TOKEN=$token" php-fpm php -r "$php_code" >/dev/null 2>&1; then
    pass 'PHP publishes through the internal Nchan endpoint'
else
    fail 'PHP failed to publish through the internal Nchan endpoint'
fi

deadline=$((SECONDS + TIMEOUT))
while ((SECONDS < deadline)); do
    grep -Fq "$token" "$sse_file" 2>/dev/null && break
    sleep 1
done
if grep -Fq 'event: changed' "$sse_file" && grep -Fq "$token" "$sse_file" && grep -Fq "$channel" "$sse_file"; then
    pass 'EventSource receives the wildcard Nchan event with its payload'
else
    fail 'EventSource did not receive the expected Nchan event'
fi

for entry in "nginx:$NGINX_RESTARTS" "php-fpm:$PHP_RESTARTS" "control:$CONTROL_RESTARTS" "opencode:$OPENCODE_RESTARTS"; do
    service="${entry%%:*}"
    before="${entry#*:}"
    after="$(restart_count "$service" 2>/dev/null || printf '')"
    if [[ -n "$before" && "$before" == "$after" ]] && container_running "$service"; then
        pass "$service remained stable during the test"
    else
        fail "$service restarted or stopped during the test"
    fi
done

printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILURES" "$SKIPS"
((FAILURES == 0))
