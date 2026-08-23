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
