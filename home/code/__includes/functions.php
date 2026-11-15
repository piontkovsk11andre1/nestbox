<?php
declare(strict_types=1);

/** Escape a value for HTML text or attribute output. */
function nestbox_escape(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

/** Encode a PHP value as a JSON literal that cannot terminate an inline script. */
function nestbox_script_json(mixed $value): string
{
    return json_encode(
        $value,
        JSON_THROW_ON_ERROR | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT,
    );
}

/** Return the configured normalized public URL prefix. */
function nestbox_url_prefix(): string
{
    $value = getenv('NESTBOX_URL_PREFIX') ?: '';
    $prefix = '/' . trim((string) $value, '/');

    if ($prefix === '/') {
        return '';
    }
    if (!preg_match('#^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)$#', $prefix)) {
        throw new UnexpectedValueException('NESTBOX_URL_PREFIX must contain only URL-safe path segments.');
    }

    return $prefix;
}

/** Build a prefix-aware URL path by encoding each path segment independently. */
function nestbox_url_path(string ...$segments): string
{
    $path = implode('/', array_map('rawurlencode', $segments));
    return nestbox_url_prefix() . '/' . $path;
}

/** Map a public URI to its page data and agent directory. */
function nestbox_page_context(string $requestUri): ?array
{
    if ($requestUri === '' || preg_match('/[\r\n]/', $requestUri)) {
        return null;
    }
    $path = parse_url($requestUri, PHP_URL_PATH);
    $query = parse_url($requestUri, PHP_URL_QUERY);
    $path = is_string($path) ? preg_replace('#/+#', '/', $path) : null;
    if (!is_string($path) || !str_starts_with($path, '/') || str_starts_with($path, '//')) {
        return null;
    }

    $route = trim($path, '/');
    if ($route === '') {
        $route = 'index';
    }
    $markdownDirection = str_ends_with(strtolower($route), '.md');
    if ($markdownDirection) {
        $route = substr($route, 0, -3);
    }
    if (!preg_match('#^[A-Za-z0-9/_-]+$#', $route)) {
        return null;
    }
    foreach (explode('/', $route) as $segment) {
        if (str_starts_with($segment, '__')) {
            return null;
        }
    }

    $routeDirectory = dirname($route);
    $relativeDirectory = $routeDirectory === '.' ? '' : '/' . $routeDirectory;
    return [
        'requestedUri' => $path . (is_string($query) ? '?' . $query : ''),
        'requestedPath' => $path,
        'route' => $route,
        'statePath' => '/home/code' . $relativeDirectory . '/__data/' . basename($route) . '.json',
        'agentDirectory' => '/nestbox/home/code' . $relativeDirectory,
    ];
}

/** Return the public OpenCode origin that corresponds to the current Nestbox host. */
function nestbox_opencode_origin(): string
{
    $configuredOrigin = rtrim((string) getenv('NESTBOX_OPENCODE_PUBLIC_URL'), '/');
    if ($configuredOrigin !== '') {
        $parts = parse_url($configuredOrigin);
        if (!is_array($parts)
            || !isset($parts['scheme'], $parts['host'])
            || !in_array(strtolower((string) $parts['scheme']), ['http', 'https'], true)
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['query'])
            || isset($parts['fragment'])
            || (isset($parts['path']) && $parts['path'] !== '')
        ) {
            throw new UnexpectedValueException('NESTBOX_OPENCODE_PUBLIC_URL must be an HTTP origin without credentials or a path.');
        }

        return $configuredOrigin;
    }

    $scheme = strtolower((string) ($_SERVER['REQUEST_SCHEME'] ?? 'http'));
    if (!in_array($scheme, ['http', 'https'], true)) {
        throw new UnexpectedValueException('The request scheme is not valid for an OpenCode URL.');
    }

    $host = trim((string) ($_SERVER['HTTP_HOST'] ?? 'localhost'));
    if (!preg_match('#^([A-Za-z0-9.-]+)(:\d{1,5})?$#', $host, $matches)) {
        throw new UnexpectedValueException('The request host is not valid for an OpenCode URL.');
    }

    $hostname = strtolower($matches[1]);
    $port = $matches[2] ?? '';
    if (in_array($hostname, ['localhost', '127.0.0.1'], true)) {
        $hostname = 'agent.localhost';
    } elseif (!str_starts_with($hostname, 'agent.')) {
        $hostname = 'agent.' . $hostname;
    }

    return "$scheme://$hostname$port";
}

/** Build the current OpenCode web UI's server-scoped session deep link. */
function nestbox_opencode_session_url(string $sessionId, string $directory): string
{
    if (!preg_match('#^[A-Za-z0-9_-]{1,128}$#', $sessionId)) {
        throw new InvalidArgumentException('Invalid OpenCode session ID.');
    }
    if (!str_starts_with($directory, '/') || str_contains($directory, "\0")) {
        throw new InvalidArgumentException('OpenCode session directories must be absolute paths.');
    }

    $origin = nestbox_opencode_origin();
    $serverKey = rtrim(strtr(base64_encode($origin), '+/', '-_'), '=');
    return $origin . '/server/' . $serverKey . '/session/' . rawurlencode($sessionId);
}

/** Send a JSON request to the internal OpenCode server for one mounted directory. */
function nestbox_opencode_request(string $method, string $path, array $body, string $directory): mixed
{
    $baseUrl = rtrim((string) getenv('NESTBOX_OPENCODE_URL'), '/');
    if ($baseUrl === '') {
        throw new RuntimeException('NESTBOX_OPENCODE_URL is not configured.');
    }
    if (!str_starts_with($path, '/')
        || !str_starts_with($directory, '/')
        || preg_match('/[\0\r\n]/', $path . $directory)
    ) {
        throw new InvalidArgumentException('Invalid OpenCode request path or directory.');
    }

    // OpenCode scopes every non-global API operation with the documented
    // directory query parameter. Older custom headers are ignored by the SDK.
    $requestUrl = $baseUrl . $path
        . (str_contains($path, '?') ? '&' : '?')
        . 'directory=' . rawurlencode($directory);
    $payload = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    $headers = [
        'Accept: application/json',
        'Content-Type: application/json',
        'Content-Length: ' . strlen($payload),
    ];
    $password = (string) getenv('OPENCODE_SERVER_PASSWORD');
    if ($password !== '') {
        $username = (string) (getenv('OPENCODE_SERVER_USERNAME') ?: 'opencode');
        $headers[] = 'Authorization: Basic ' . base64_encode("$username:$password");
    }

    $context = stream_context_create([
        'http' => [
            'method' => strtoupper($method),
            'header' => implode("\r\n", $headers),
            'content' => $payload,
            'ignore_errors' => true,
            'timeout' => 10,
        ],
    ]);
    $response = @file_get_contents($requestUrl, false, $context);
    $statusLine = $http_response_header[0] ?? '';
    preg_match('#^HTTP/\S+\s+(\d{3})#', $statusLine, $matches);
    $status = isset($matches[1]) ? (int) $matches[1] : 0;

    if ($response === false || $status < 200 || $status >= 300) {
        throw new RuntimeException("OpenCode request failed with HTTP status $status.");
    }
    if ($response === '' || $status === 204) {
        return null;
    }

    return json_decode($response, true, flags: JSON_THROW_ON_ERROR);
}

/** Read a positive integer setting for do-md; reject malformed configuration. */
function nestbox_do_md_config_int(string $name, int $default): int
{
    $raw = getenv($name);
    if ($raw === false || $raw === '') {
        return $default;
    }
    $value = filter_var($raw, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if ($value === false) {
        throw new UnexpectedValueException("$name must be a positive integer.");
    }
    return $value;
}

/** Send one bounded, non-retried HTTP request; return its status and API-v1 body. */
function nestbox_do_md_request(string $method, string $path, ?array $body = null): array
{
    $baseUrl = rtrim((string) (getenv('NESTBOX_DO_MD_URL') ?: 'http://do-md:8080'), '/');
    $url = parse_url($baseUrl);
    if (!is_array($url) || !isset($url['host'], $url['scheme'])
        || !in_array($url['scheme'], ['http', 'https'], true)
        || isset($url['user']) || isset($url['pass'])
        || isset($url['query']) || isset($url['fragment']) || preg_match('/[\0\r\n]/', $baseUrl)
    ) {
        throw new UnexpectedValueException('NESTBOX_DO_MD_URL must be an HTTP(S) URL without credentials, query, or fragment.');
    }
    $metadata = in_array($path, ['/healthz', '/v1/capabilities'], true);
    $command = preg_match('#\A/v1/commands/[a-z]+\z#', $path) === 1;
    if (!(($method === 'GET' && $metadata && $body === null) || ($method === 'POST' && $command && $body !== null))) {
        throw new InvalidArgumentException('Invalid do-md request method, path, or body.');
    }
    $payload = $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    if ($payload !== null && strlen($payload) > 1048576) {
        throw new InvalidArgumentException('do-md JSON request exceeds 1048576 bytes.');
    }
    $options = [
        'method' => $method,
        'header' => "Accept: application/json\r\nContent-Type: application/json",
        'ignore_errors' => true,
        'follow_location' => 0,
        'max_redirects' => 0,
        'timeout' => nestbox_do_md_config_int('NESTBOX_DO_MD_TIMEOUT_MS', 20000) / 1000 + 5,
    ];
    if ($payload !== null) {
        $options['content'] = $payload;
    }
    // A disconnect can follow a committed write: do not retry or claim rollback.
    $stream = @fopen($baseUrl . $path, 'rb', false, stream_context_create(['http' => $options]));
    if ($stream === false) {
        throw new RuntimeException('do-md connection failed; write outcome may be unknown. Request was not retried.');
    }
    try {
        $response = stream_get_contents($stream, 8388609);
        $metadata = stream_get_meta_data($stream);
    } finally {
        fclose($stream);
    }
    if ($response === false || ($metadata['timed_out'] ?? false) || strlen($response) > 8388608) {
        throw new RuntimeException('do-md response timed out or exceeded 8388608 bytes; write outcome may be unknown. Request was not retried.');
    }
    $status = 0;
    $contentType = '';
    foreach ($metadata['wrapper_data'] ?? [] as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#i', $header, $matches)) {
            $status = (int) $matches[1];
            $contentType = '';
        } elseif (stripos($header, 'Content-Type:') === 0) {
            $contentType = trim(substr($header, strlen('Content-Type:')));
        }
    }
    if ($status < 200 || ($status >= 300 && $status < 400) || $status >= 600 || !preg_match('#^application/json(?:;|$)#i', $contentType)) {
        throw new RuntimeException("do-md returned an invalid response with HTTP status $status.");
    }
    try {
        $decoded = json_decode($response, true, flags: JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        throw new RuntimeException('do-md returned invalid JSON.', 0, $error);
    }
    if (!is_array($decoded) || array_is_list($decoded) || ($decoded['apiVersion'] ?? null) !== 1 || !is_bool($decoded['ok'] ?? null)) {
        throw new UnexpectedValueException('do-md returned an incompatible or malformed API response.');
    }
    return ['status' => $status, 'body' => $decoded];
}

/** Check the default do-md service without touching documents. */
function nestbox_do_md_health(): array
{
    $response = nestbox_do_md_request('GET', '/healthz');
    if ($response['status'] !== 200 || !$response['body']['ok'] || !is_string($response['body']['version'] ?? null)) {
        throw new RuntimeException('do-md is not healthy.');
    }
    return $response['body'];
}

/** Fetch the remote execution schemas and configured resource limits. */
function nestbox_do_md_capabilities(): array
{
    $response = nestbox_do_md_request('GET', '/v1/capabilities');
    if ($response['status'] !== 200 || !$response['body']['ok'] || !is_array($response['body']['commands'] ?? null)) {
        throw new RuntimeException('do-md capabilities are unavailable.');
    }
    $names = array_column($response['body']['commands'], 'name');
    foreach (['validate', 'export', 'create', 'set', 'render', 'match', 'query', 'reference'] as $name) {
        if (!in_array($name, $names, true)) {
            throw new UnexpectedValueException("do-md does not support $name.");
        }
    }
    return $response['body'];
}

/** Execute one scoped operation; return domain/HTTP diagnostics, throw on transport errors. */
function nestbox_do_md(string $command, array $params = [], string $directory = '/workspace', array $limits = []): array
{
    if (!in_array($command, ['validate', 'export', 'create', 'set', 'render', 'match', 'query', 'reference'], true)) {
        throw new InvalidArgumentException('Unknown do-md command.');
    }
    if ((!str_starts_with($directory, '/') && !preg_match('#^[A-Za-z]:/#', $directory)) || preg_match('/[\0\r\n]/', $directory)) {
        throw new InvalidArgumentException('do-md directory must be an absolute server-side path.');
    }
    if ($params !== [] && array_is_list($params)) {
        throw new InvalidArgumentException('do-md params must be an object.');
    }
    // Preserve JSON object semantics for empty PHP arrays in schema-object fields.
    foreach (['data', 'patch', 'options'] as $field) {
        if (isset($params[$field]) && is_array($params[$field])) {
            if ($params[$field] !== [] && array_is_list($params[$field])) {
                throw new InvalidArgumentException("do-md $field must be an object.");
            }
            $params[$field] = (object) $params[$field];
        }
    }
    foreach ($limits as $name => $value) {
        if (!in_array($name, ['timeoutMs', 'maxInputBytes', 'noSnippets'], true)
            || ($name === 'noSnippets' ? !is_bool($value) : (!is_int($value) || $value < 1))
        ) {
            throw new InvalidArgumentException('Invalid do-md resource limit.');
        }
    }
    $limits['timeoutMs'] = min($limits['timeoutMs'] ?? PHP_INT_MAX, nestbox_do_md_config_int('NESTBOX_DO_MD_TIMEOUT_MS', 20000));
    $response = nestbox_do_md_request('POST', '/v1/commands/' . $command, [
        'directory' => $directory, 'params' => (object) $params, 'limits' => (object) $limits,
    ]);
    $result = $response['body'];
    if (!is_int($result['exitCode'] ?? null) || $result['exitCode'] < 0 || $result['exitCode'] > 4
        || !is_array($result['errors'] ?? null) || !array_is_list($result['errors'])
        || ($result['ok'] && ($response['status'] !== 200 || $result['exitCode'] !== 0 || $result['errors'] !== []))
        || (!$result['ok'] && ($result['exitCode'] === 0 || $result['errors'] === []))
    ) {
        throw new UnexpectedValueException('do-md returned a malformed command result.');
    }
    foreach ($result['errors'] as $error) {
        if (!is_array($error) || !is_string($error['code'] ?? null) || !is_string($error['message'] ?? null)) {
            throw new UnexpectedValueException('do-md returned malformed diagnostics.');
        }
    }
    if ($result['ok']) {
        $valid = match ($command) {
            'create', 'set', 'render' => is_string($result['output'] ?? null)
                && array_key_exists('wrote', $result) && ($result['wrote'] === null || is_string($result['wrote'])),
            'export' => is_array($result['context'] ?? null),
            'match', 'query' => is_array($result['matches'] ?? null) && array_is_list($result['matches']),
            'reference' => is_array($result['reference'] ?? null) || is_string($result['reference'] ?? null),
            default => true,
        };
        if (!$valid) {
            throw new UnexpectedValueException('do-md returned malformed command output.');
        }
    }
    return $result;
}

/** Validate a document through the shared do-md backend. */
function nestbox_do_md_validate(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('validate', $params, $directory, $limits);
}

/** Export context inline or to the optional server-side savePath. */
function nestbox_do_md_export(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('export', $params, $directory, $limits);
}

/** Create Markdown inline or at the optional server-side file. */
function nestbox_do_md_create(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('create', $params, $directory, $limits);
}

/** Apply a document mutation; dryRun returns output without writing. */
function nestbox_do_md_set(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('set', $params, $directory, $limits);
}

/** Parse and render with two templates, optionally without writing. */
function nestbox_do_md_render(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('render', $params, $directory, $limits);
}

/** Find full-document template matches inside the selected directory. */
function nestbox_do_md_match(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('match', $params, $directory, $limits);
}

/** Find partial-document regions inside the selected directory. */
function nestbox_do_md_query(array $params, string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('query', $params, $directory, $limits);
}

/** Read the executing version's reference or one function entry. */
function nestbox_do_md_reference(array $params = [], string $directory = '/workspace', array $limits = []): array
{
    return nestbox_do_md('reference', $params, $directory, $limits);
}

/** Send a bounded JSON request to the private, label-gated control service. */
function nestbox_control_request(string $method, string $path, array $body = []): mixed
{
    $baseUrl = rtrim((string) getenv('NESTBOX_CONTROL_URL'), '/');
    if ($baseUrl === '') {
        throw new RuntimeException('NESTBOX_CONTROL_URL is not configured.');
    }
    if (!str_starts_with($path, '/') || preg_match('/[\0\r\n]/', $path)) {
        throw new InvalidArgumentException('Invalid control request path.');
    }

    $payload = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    $context = stream_context_create([
        'http' => [
            'method' => strtoupper($method),
            'header' => implode("\r\n", [
                'Accept: application/json',
                'Content-Type: application/json',
                'Content-Length: ' . strlen($payload),
            ]),
            'content' => $payload,
            'ignore_errors' => true,
            'timeout' => 30,
        ],
    ]);
    $response = @file_get_contents($baseUrl . $path, false, $context, 0, 1024 * 1024);
    $statusLine = $http_response_header[0] ?? '';
    preg_match('#^HTTP/\S+\s+(\d{3})#', $statusLine, $matches);
    $status = isset($matches[1]) ? (int) $matches[1] : 0;
    if ($response === false || $status < 200 || $status >= 300) {
        throw new RuntimeException("Control request failed with HTTP status $status.");
    }
    return $response === '' ? null : json_decode($response, true, flags: JSON_THROW_ON_ERROR);
}

/** Execute one explicit argument array in an allowed Compose service. */
function nestbox_control_exec(
    string $service,
    string $workdir,
    array $command,
    bool $detach = false,
    string $user = '',
): array {
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/', $service)) {
        throw new InvalidArgumentException('Invalid control target service.');
    }
    if (!str_starts_with($workdir, '/') || str_contains($workdir, "\0")) {
        throw new InvalidArgumentException('Control workdir must be an absolute container path.');
    }
    if ($command === [] || count($command) > 256) {
        throw new InvalidArgumentException('Control command must be a non-empty bounded argument array.');
    }
    foreach ($command as $part) {
        if (!is_string($part) || str_contains($part, "\0")) {
            throw new InvalidArgumentException('Every control command argument must be a string.');
        }
    }
    $body = ['command' => array_values($command), 'workdir' => $workdir, 'detach' => $detach];
    if ($user !== '') {
        $body['user'] = $user;
    }
    $result = nestbox_control_request('POST', '/containers/' . rawurlencode($service) . '/exec', $body);
    if (!is_array($result) || !isset($result['runId']) || !is_string($result['runId'])) {
        throw new RuntimeException('Control service returned an invalid exec response.');
    }
    return $result;
}

/** Create an OpenCode session synchronously so its ID is available immediately. */
function nestbox_opencode_create_session(string $title, string $directory = '/workspace'): array
{
    $session = nestbox_opencode_request('POST', '/session', ['title' => $title], $directory);
    if (!is_array($session)
        || !isset($session['id'])
        || !is_string($session['id'])
        || !preg_match('#^[A-Za-z0-9_-]{1,128}$#', $session['id'])
    ) {
        throw new RuntimeException('OpenCode did not return a session ID.');
    }

    return $session;
}

/** Queue a prompt, with optional system context, without waiting for the response. */
function nestbox_opencode_prompt_async(
    string $sessionId,
    string $prompt,
    string $system,
    string $directory = '/workspace',
): void {
    if (!preg_match('#^[A-Za-z0-9_-]{1,128}$#', $sessionId)) {
        throw new InvalidArgumentException('Invalid OpenCode session ID.');
    }

    $payload = [
        'parts' => [[
            'type' => 'text',
            'text' => $prompt,
        ]],
    ];
    if ($system !== '') {
        $payload['system'] = $system;
    }

    nestbox_opencode_request('POST', '/session/' . rawurlencode($sessionId) . '/prompt_async', $payload, $directory);
}

/** Validate and normalize an exact or suffix-wildcard event topic. */
function nestbox_bus_topic(string $topic, bool $allowWildcard = true): string
{
    $topic = trim($topic);
    $segment = '[A-Za-z0-9][A-Za-z0-9._/-]{0,63}';
    $pattern = $allowWildcard
        ? "#^(?:$segment)(?::$segment)*(?::\\*)?$#"
        : "#^(?:$segment)(?::$segment)*$#";

    if (strlen($topic) > 128 || !preg_match($pattern, $topic)) {
        throw new InvalidArgumentException("Invalid Nestbox event topic: $topic");
    }

    return $topic;
}

/** Build a same-origin, prefix-aware EventSource URL for one or more topics. */
function nestbox_bus_url(string ...$topics): string
{
    if ($topics === []) {
        throw new InvalidArgumentException('At least one Nestbox event topic is required.');
    }

    $topics = array_values(array_unique(array_map(
        static fn (string $topic): string => nestbox_bus_topic($topic),
        $topics,
    )));
    if (count($topics) > 16) {
        throw new LengthException('A Nestbox EventSource can subscribe to at most 16 topics.');
    }

    return nestbox_url_path('_nestbox', 'events') . '?topics=' . implode(',', $topics);
}

/** Best-effort publication to an exact topic and its suffix wildcard. */
function nestbox_bus_publish(string $topic, string $event = 'changed', array $data = []): bool
{
    $topic = nestbox_bus_topic($topic, false);
    if (!preg_match('#^[A-Za-z][A-Za-z0-9_.-]{0,63}$#', $event)) {
        throw new InvalidArgumentException("Invalid Nestbox event name: $event");
    }

    $topics = [$topic];
    $separator = strrpos($topic, ':');
    if ($separator !== false) {
        $topics[] = substr($topic, 0, $separator + 1) . '*';
    }

    $payload = json_encode([
        'topic' => $topic,
        'event' => $event,
        'data' => $data,
    ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

    if (strlen($payload) > 64 * 1024) {
        throw new LengthException('Nestbox event payloads cannot exceed 64 KiB.');
    }

    $publisher = getenv('NESTBOX_BUS_PUBLISH_URL');
    if (!$publisher) {
        error_log('Nestbox event publication skipped: NESTBOX_BUS_PUBLISH_URL is not configured.');
        return false;
    }

    $url = $publisher . (str_contains($publisher, '?') ? '&' : '?')
        . 'topics=' . implode(',', $topics);
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", [
                'Content-Type: application/json',
                'X-EventSource-Event: ' . $event,
                'Content-Length: ' . strlen($payload),
            ]),
            'content' => $payload,
            'ignore_errors' => true,
            'timeout' => 2,
        ],
    ]);

    $response = @file_get_contents($url, false, $context);
    $statusLine = $http_response_header[0] ?? '';
    preg_match('#^HTTP/\S+\s+(\d{3})#', $statusLine, $matches);
    $status = isset($matches[1]) ? (int) $matches[1] : 0;

    if ($response === false || !in_array($status, [201, 202], true)) {
        error_log("Nestbox event publication failed with HTTP status $status.");
        return false;
    }

    return true;
}
