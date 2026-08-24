param(
    [switch]$Start,
    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds = 30,
    [string]$PageRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Passes = 0
$Failures = 0
$Skips = 0
$Root = Split-Path -Parent $PSScriptRoot
if (-not $PageRoot) { $PageRoot = Join-Path $Root 'home\code' }
if (-not [System.IO.Path]::IsPathRooted($PageRoot)) { $PageRoot = Join-Path $Root $PageRoot }
$PageRoot = [System.IO.Path]::GetFullPath($PageRoot)
if ($PSBoundParameters.ContainsKey('PageRoot')) { $env:NESTBOX_PAGE_PATH = $PageRoot }
$TempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("nestbox-test-" + [guid]::NewGuid().ToString('N'))
$Client = $null
$SseJob = $null

function Pass([string]$Message) {
    $script:Passes++
    Write-Output "PASS  $Message"
}

function Fail([string]$Message) {
    $script:Failures++
    [Console]::Error.WriteLine("FAIL  $Message")
}

function Skip([string]$Message) {
    $script:Skips++
    Write-Output "SKIP  $Message"
}

function Invoke-Compose([string[]]$Arguments, [switch]$Quiet) {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& docker compose --project-directory $Root @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if (-not $Quiet -and $null -ne $output) {
        $output | ForEach-Object { [Console]::Out.WriteLine($_.ToString()) }
    }
    return [pscustomobject]@{ Code = $code; Output = @($output) }
}

function Get-ContainerId([string]$Service) {
    $result = Invoke-Compose @('ps', '-q', $Service) -Quiet
    if ($result.Code -ne 0) { return '' }
    return (($result.Output -join "`n").Trim())
}

function Get-RestartCount([string]$Service) {
    $id = Get-ContainerId $Service
    if (-not $id) { return $null }
    $value = & docker inspect --format '{{.RestartCount}}' $id 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return [int]$value
}

function Test-ContainerRunning([string]$Service) {
    $id = Get-ContainerId $Service
    if (-not $id) { return $false }
    $value = & docker inspect --format '{{.State.Running}}' $id 2>$null
    return $LASTEXITCODE -eq 0 -and $value -eq 'true'
}

function Invoke-Http([string]$Path, [string]$HostHeader = '', [string]$Method = 'GET') {
    $request = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), "$script:BaseUrl$Path")
    $response = $null
    if ($HostHeader) { $request.Headers.Host = $HostHeader }
    try {
        $response = $script:Client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $headers = @{}
        foreach ($header in $response.Headers) { $headers[$header.Key.ToLowerInvariant()] = ($header.Value -join ', ') }
        foreach ($header in $response.Content.Headers) { $headers[$header.Key.ToLowerInvariant()] = ($header.Value -join ', ') }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Headers = $headers; Body = $body }
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
    }
}

try {
    New-Item -ItemType Directory -Path $TempDirectory | Out-Null
    $configuredTokenFile = [regex]::Match([IO.File]::ReadAllText((Join-Path $Root '.env')), '(?m)^NESTBOX_HOST_TOKEN_FILE=(.+)$').Groups[1].Value.Trim()
    if (-not $env:NESTBOX_HOST_TOKEN_FILE -and -not $configuredTokenFile) {
        $env:NESTBOX_HOST_TOKEN_FILE = Join-Path $TempDirectory 'host-token'
        [IO.File]::WriteAllText($env:NESTBOX_HOST_TOKEN_FILE, 'test-token-' + ('0' * 54))
    }

    if (Get-Command docker -ErrorAction SilentlyContinue) { Pass 'docker is available' } else { Fail 'docker is required'; throw 'Missing Docker' }
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) { Pass 'curl.exe is available' } else { Fail 'curl.exe is required'; throw 'Missing curl.exe' }
    $composeVersion = & docker compose version 2>$null
    if ($LASTEXITCODE -eq 0) { Pass 'Docker Compose v2 is available' } else { Fail 'Docker Compose v2 is required'; throw 'Missing Docker Compose' }

    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $Client = New-Object System.Net.Http.HttpClient($handler)
    $Client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)

    if (Test-Path -LiteralPath (Join-Path $Root '.env') -PathType Leaf) { Pass '.env exists' } else { Fail '.env is missing' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'home\.git') -PathType Container)) { Pass 'Page and configuration tree has no embedded Git repository' } else { Fail 'home/.git must not be included in an installation' }
    $indexPresent = Test-Path -LiteralPath (Join-Path $PageRoot 'index.php') -PathType Leaf
    if ($indexPresent) { Pass 'Page tree has an implemented index.php' } else { Pass 'Fresh page tree intentionally has no index.php' }
    $openCodeInstructions = [IO.File]::ReadAllText((Join-Path $Root 'home\configs\opencode\instructions.md'))
    if ($openCodeInstructions.Contains('free of empty lines between its nested or adjacent element tags')) { Pass 'OpenCode instructions enforce contiguous raw HTML blocks' } else { Fail 'OpenCode instructions omit the raw HTML blank-line invariant' }
    if ($openCodeInstructions.Contains('## PHP To OpenCode API')) { Pass 'OpenCode instructions document the PHP API' } else { Fail 'OpenCode instructions omit the PHP API contract' }
    if ($openCodeInstructions.Contains('## Extending The Environment')) { Pass 'OpenCode instructions document environment extension' } else { Fail 'OpenCode instructions omit environment extension guidance' }
    if ($openCodeInstructions.Contains('deliberately has no Docker socket')) { Pass 'OpenCode instructions preserve the host container boundary' } else { Fail 'OpenCode instructions omit the host container boundary' }
    if (Test-Path -LiteralPath (Join-Path $Root 'home\configs\opencode\instance.example.md') -PathType Leaf) { Pass 'OpenCode instance policy template exists' } else { Fail 'OpenCode instance policy template is missing' }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'home\configs\opencode\instance.md') -PathType Leaf)) { Fail 'Copy instance.example.md to instance.md before startup'; throw 'Missing OpenCode instance policy' }
    $openCodeInstance = [IO.File]::ReadAllText((Join-Path $Root 'home\configs\opencode\instance.md'))
    if ($openCodeInstance.Contains('Commit policy:')) { Pass 'OpenCode instance policy records commit behavior' } else { Fail 'OpenCode instance policy omits commit behavior' }
    if ($openCodeInstance.Contains('Communication language:')) { Pass 'OpenCode instance policy records communication language' } else { Fail 'OpenCode instance policy omits communication language' }
    $openCodeConfig = [IO.File]::ReadAllText((Join-Path $Root 'home\configs\opencode\opencode.json'))
    if ($openCodeConfig.Contains('"instance.md"')) { Pass 'OpenCode loads instance policy directly' } else { Fail 'OpenCode does not load instance policy' }
    if ($openCodeConfig.Contains('"control"')) { Pass 'OpenCode registers the control MCP' } else { Fail 'OpenCode does not register the control MCP' }
    if ((Test-Path -LiteralPath (Join-Path $Root 'docker\control\server.py')) -and (Test-Path -LiteralPath (Join-Path $Root 'host-runner.mjs'))) { Pass 'Control and host runner sources exist' } else { Fail 'Control or host runner source is missing' }

    $result = Invoke-Compose @('config', '--quiet') -Quiet
    if ($result.Code -eq 0) { Pass 'Compose configuration is valid' } else { Fail 'Compose configuration is invalid' }

    $result = Invoke-Compose @('config', '--services') -Quiet
    $services = @($result.Output | ForEach-Object { $_.ToString().Trim() })
    foreach ($service in @('nginx', 'php-fpm', 'rollup', 'control', 'opencode')) {
        if ($services -contains $service) { Pass "Compose defines $service" } else { Fail "Compose does not define $service" }
    }
    $result = Invoke-Compose @('ps', '--services') -Quiet
    foreach ($service in @($result.Output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })) {
        if ($services -notcontains $service) { Fail "Compose project contains unexpected service $service; choose a unique COMPOSE_PROJECT_NAME" }
    }

    if ($Start) {
        $result = Invoke-Compose @('build', 'nginx', 'php-fpm', 'rollup', 'control', 'opencode')
        if ($result.Code -eq 0) { Pass 'All service images build' } else { Fail 'One or more service images failed to build' }

        # Do not start the bind-mounted Rollup watcher: it intentionally writes
        # generated bundles. Its image and output are validated separately.
        $result = Invoke-Compose @('up', '-d', 'nginx', 'php-fpm', 'control', 'opencode')
        if ($result.Code -eq 0) { Pass 'Application services started' } else { Fail 'Application services failed to start' }
    }

    foreach ($service in @('nginx', 'php-fpm', 'control', 'opencode')) {
        if (Test-ContainerRunning $service) { Pass "$service is running" } else { Fail "$service is not running" }
    }
    $rollupId = Get-ContainerId 'rollup'
    if ($rollupId) {
        if (Test-ContainerRunning 'rollup') { Pass 'rollup is running' } else { Fail 'rollup exists but is not running' }
    } else {
        Skip 'rollup watcher is not running; generated bundles are tested from the image'
    }

    $restartCounts = @{}
    foreach ($service in @('nginx', 'php-fpm', 'control', 'opencode')) { $restartCounts[$service] = Get-RestartCount $service }

    $result = Invoke-Compose @('port', 'nginx', '80') -Quiet
    $published = ($result.Output -join "`n").Trim()
    if ($published -notmatch '^(?:\[(?<ipv6>.+)\]|(?<host>[^:]+)):(?<port>\d+)$') {
        Fail 'Could not resolve the published Nginx port'
        throw 'Missing published port'
    }
    $webHost = if ($Matches.ipv6) { $Matches.ipv6 } else { $Matches.host }
    $webPort = [int]$Matches.port
    if ($webHost -eq '0.0.0.0' -or $webHost -eq '::') { $webHost = '127.0.0.1' }
    $urlHost = if ($webHost.Contains(':')) { "[$webHost]" } else { $webHost }
    $BaseUrl = "http://${urlHost}:$webPort"
    Pass "Nginx is published at $BaseUrl"

    $health = $null
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try { $health = Invoke-Http '/_nestbox/health' } catch { $health = $null }
        if ($null -ne $health -and $health.Status -eq 200) { break }
        Start-Sleep -Seconds 1
    }
    if ($null -ne $health -and $health.Status -eq 200) { Pass 'Nginx and PHP health endpoint responds' } else { Fail 'Health endpoint did not become ready' }

    $result = Invoke-Compose @('exec', '-T', 'nginx', 'nginx', '-t') -Quiet
    if ($result.Code -eq 0) { Pass 'Nginx configuration is valid' } else { Fail 'Nginx configuration is invalid' }
    $result = Invoke-Compose @('exec', '-T', 'nginx', 'apk', 'info', '-e', 'nginx') -Quiet
    if ($result.Code -eq 0) { Pass 'Alpine Nginx package is installed' } else { Fail 'Alpine Nginx package is missing' }
    $result = Invoke-Compose @('exec', '-T', 'nginx', 'apk', 'info', '-e', 'nginx-mod-http-nchan') -Quiet
    if ($result.Code -eq 0) { Pass 'Alpine Nchan package is installed' } else { Fail 'Alpine Nchan package is missing' }
    $result = Invoke-Compose @('exec', '-T', 'nginx', 'nginx', '-T') -Quiet
    if (($result.Output -join "`n") -match 'ngx_nchan_module\.so') { Pass 'Nchan dynamic module is loaded' } else { Fail 'Nchan dynamic module is not loaded' }

    if ($indexPresent) {
        $response = Invoke-Http '/'
        if ($response.Status -eq 200) { Pass 'Main super-document returns HTTP 200' } else { Fail "Main super-document returned HTTP $($response.Status)" }
        if ($response.Headers['content-type'] -like 'text/html*') { Pass 'Main super-document is HTML' } else { Fail 'Main super-document has the wrong content type' }
    } else {
        $response = Invoke-Http '/'
        if ($response.Status -eq 404 -and $response.Body.Contains('Create and open session')) { Pass 'Fresh root renders the OpenCode implementation form with HTTP 404' } else { Fail 'Fresh root did not render the OpenCode implementation form with HTTP 404' }
    }
    foreach ($header in @('content-security-policy', 'x-content-type-options', 'referrer-policy', 'cache-control')) {
        if ($response.Headers.ContainsKey($header)) { Pass "$header is present" } else { Fail "$header is missing" }
    }
    if ($response.Headers['cache-control'] -like '*no-store*') { Pass 'Nestbox responses disable browser caching' } else { Fail 'Nestbox responses permit browser caching' }

    if ($indexPresent) {
        $response = Invoke-Http '/index.md'
        if ($response.Status -eq 200) { Pass 'Markdown direction returns HTTP 200' } else { Fail "Markdown direction returned HTTP $($response.Status)" }
        if ($response.Headers['content-type'] -like 'text/markdown*') { Pass 'Markdown direction has text/markdown content type' } else { Fail 'Markdown direction has the wrong content type' }
    } else {
        $response = Invoke-Http '/index.md'
        if ($response.Status -eq 404) { Pass 'Fresh index Markdown direction remains unresolved' } else { Fail "Fresh index Markdown direction returned HTTP $($response.Status)" }
    }

    foreach ($asset in @('scripts-bundle.js', 'scripts-bundle.css', 'styles.css')) {
        $response = Invoke-Http "/$asset"
        if ($response.Status -eq 200 -and $response.Body.Length -gt 0) { Pass "$asset is served and nonempty" } else { Fail "$asset is unavailable or empty" }
        if ($response.Headers['cache-control'] -like '*no-store*') { Pass "$asset disables browser caching" } else { Fail "$asset permits browser caching" }
    }

    foreach ($path in @('/index.php', '/__templates/super-document', '/__includes/functions.php', '/__data/example.json', '/docs/__data/install.json')) {
        $response = Invoke-Http $path
        if ($response.Status -eq 404) { Pass "$path is protected" } else { Fail "$path returned HTTP $($response.Status) instead of 404" }
    }
    $response = Invoke-Http '/.user.ini'
    if ($response.Status -eq 403 -or $response.Status -eq 404) { Pass 'Dotfiles are protected' } else { Fail "Dotfile returned HTTP $($response.Status)" }

    $missingPath = "/missing-$([guid]::NewGuid().ToString('N'))"
    $missingUri = "$missingPath`?view=full"
    $response = Invoke-Http $missingUri
    $expected404Body = $response.Body.Contains('Create and open session')
    if ($response.Status -eq 404 -and $expected404Body) { Pass 'Missing routes render the interactive PHP 404 document' } else { Fail 'Missing route did not render the interactive PHP 404 document' }
    if ($response.Body.Contains("name=`"requested_uri`" value=`"$missingUri`"")) { Pass 'Interactive 404 preserves the requested page URI' } else { Fail 'Interactive 404 lost the requested page URI' }
    if ($response.Body.Contains('name="prompt" type="text"') -and $response.Body.Contains('target="nestbox-opencode"')) { Pass 'Interactive 404 uses a one-line prompt and the shared OpenCode window' } else { Fail 'Interactive 404 prompt form has the wrong behavior' }
    if ($response.Body.Contains('nestbox-toolbar') -and $response.Body.Contains('Open Chat') -and -not $response.Body.Contains('Continue in OpenCode')) { Pass 'Shared header opens the common OpenCode chat' } else { Fail 'Shared header contains page-specific session controls' }
    $response = Invoke-Http '/404' '' 'POST'
    if ($response.Status -eq 422) { Pass 'Interactive 404 rejects invalid requests' } else { Fail "Interactive 404 accepted an invalid request with HTTP $($response.Status)" }

    $nginxId = Get-ContainerId 'nginx'
    $inspectOutput = & docker inspect $nginxId 2>$null
    $inspectCode = $LASTEXITCODE
    $publisherBinding = if ($inspectCode -eq 0) { (@($inspectOutput | ConvertFrom-Json)[0].NetworkSettings.Ports).'8080/tcp' } else { 'inspection-failed' }
    if ($inspectCode -eq 0 -and $null -eq $publisherBinding) { Pass 'Internal publisher port is not published on the host' } else { Fail 'Internal publisher port is published on the host' }
    $response = Invoke-Http '/_nestbox/publish?topics=nestbox-test:public' '' 'POST'
    if ($response.Status -eq 404) { Pass 'Publisher endpoint is unavailable on the public port' } else { Fail "Public publisher endpoint returned HTTP $($response.Status)" }

    $controlId = Get-ContainerId 'control'
    $controlInspect = @(& docker inspect $controlId 2>$null | ConvertFrom-Json)[0]
    if ($null -eq $controlInspect.NetworkSettings.Ports.'4088/tcp') { Pass 'Control API is not published on the host' } else { Fail 'Control API is published on the host' }
    $runnerBinding = $controlInspect.NetworkSettings.Ports.'4089/tcp'
    if ($null -eq $runnerBinding) { Pass 'Host runner API is not published separately' } else { Fail 'Host runner API is published separately' }
    $response = Invoke-Http '/_nestbox/host/health'
    if ($response.Status -eq 401) { Pass 'Nginx routes the authenticated host runner API' } else { Fail "Host runner gateway returned HTTP $($response.Status) instead of 401" }
    $openCodeId = Get-ContainerId 'opencode'
    $openCodeInspect = @(& docker inspect $openCodeId 2>$null | ConvertFrom-Json)[0]
    if (@($openCodeInspect.Mounts.Destination) -notcontains '/var/run/docker.sock') { Pass 'OpenCode does not receive the Docker socket' } else { Fail 'OpenCode receives the Docker socket' }
    if (@($openCodeInspect.Mounts.Destination) -notcontains '/run/secrets/nestbox-host-token' -and @($openCodeInspect.Config.Env) -notmatch '^NESTBOX_HOST_TOKEN=') { Pass 'OpenCode cannot read the host runner token' } else { Fail 'OpenCode can read the host runner token' }
    if (@($controlInspect.Mounts.Destination) -contains '/var/run/docker.sock') { Pass 'Control receives the Docker socket' } else { Fail 'Control does not receive the Docker socket' }
    if (@($controlInspect.Mounts.Destination) -contains '/run/secrets/nestbox-host-token') { Pass 'Control receives the host runner token file' } else { Fail 'Control does not receive the host runner token file' }

    if ($indexPresent) {
        $result = Invoke-Compose @('exec', '-T', 'php-fpm', 'php', '-l', '/home/code/index.php') -Quiet
        if ($result.Code -eq 0) { Pass 'Installed super-document passes PHP lint' } else { Fail 'Installed super-document failed PHP lint' }
    } else {
        Pass 'Fresh page tree has no index.php to lint'
    }
    $result = Invoke-Compose @('exec', '-T', 'php-fpm', 'php', '-l', '/home/code/404.php') -Quiet
    if ($result.Code -eq 0) { Pass 'Interactive 404 super-document passes PHP lint' } else { Fail 'Interactive 404 super-document failed PHP lint' }
    $contextCode = "require '/home/code/__includes/functions.php'; `$context = nestbox_page_context('/docs/install?tab=all'); exit((`$context['statePath'] === '/home/code/docs/__data/install.json' && `$context['agentDirectory'] === '/nestbox/home/code/docs') ? 0 : 1);"
    $result = Invoke-Compose @('exec', '-T', 'php-fpm', 'php', '-r', $contextCode) -Quiet
    if ($result.Code -eq 0) { Pass 'Nested pages map to directory-local data and agent scope' } else { Fail 'Nested page data or agent context is incorrect' }
    $result = Invoke-Compose @('exec', '-T', 'php-fpm', 'php', '/sources/php/cli.php', '__templates/super-document') -Quiet
    if ($result.Code -ne 0) { Pass 'CLI router rejects protected super-documents' } else { Fail 'Protected super-document executed through the CLI router' }

    $openCodeHealthCode = "require '/home/code/__includes/functions.php'; `$health = nestbox_opencode_request('GET', '/global/health', [], '/workspace'); exit((`$health['healthy'] ?? false) ? 0 : 1);"
    $result = Invoke-Compose @('exec', '-T', 'php-fpm', 'php', '-r', $openCodeHealthCode) -Quiet
    if ($result.Code -eq 0) { Pass 'PHP reaches the authenticated internal OpenCode API' } else { Fail 'PHP cannot reach the authenticated internal OpenCode API' }

    $response = Invoke-Http '/Agent' "localhost:$webPort"
    $location = $response.Headers['location']
    if ($response.Status -eq 302 -and $location -eq "http://agent.localhost:$webPort/") { Pass '/Agent redirects to the same-port OpenCode origin' } else { Fail "/Agent redirect was HTTP $($response.Status) with Location $location" }

    $response = Invoke-Http '/doc' "agent.localhost:$webPort"
    if ($response.Status -eq 401 -or ($response.Status -ge 200 -and $response.Status -lt 400)) { Pass 'OpenCode host routing responds' } else { Fail "OpenCode host routing returned HTTP $($response.Status)" }

    $channel = "nestbox-test:$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$PID"
    $token = "event-$([guid]::NewGuid().ToString('N'))"
    $sseUrl = "$BaseUrl/_nestbox/events?topics=nestbox-test:*"
    $SseJob = Start-Job -ScriptBlock {
        param($Url, $Timeout)
        & curl.exe --silent --show-error --noproxy '*' --no-buffer --max-time $Timeout --header 'Accept: text/event-stream' $Url
    } -ArgumentList $sseUrl, $TimeoutSeconds

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $sseText = ''
    while ([DateTime]::UtcNow -lt $deadline) {
        $sseText = @(Receive-Job -Job $SseJob -Keep) -join "`n"
        if ($sseText.Contains(': hi')) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($sseText.Contains(': hi')) { Pass 'EventSource subscriber is connected' } else { Fail 'EventSource subscriber did not connect' }

    $phpCode = "require '/home/code/__includes/functions.php'; exit(nestbox_bus_publish(getenv('TEST_TOPIC'), 'changed', ['token' => getenv('TEST_TOKEN')]) ? 0 : 1);"
    $result = Invoke-Compose @('exec', '-T', '-e', "TEST_TOPIC=$channel", '-e', "TEST_TOKEN=$token", 'php-fpm', 'php', '-r', $phpCode) -Quiet
    if ($result.Code -eq 0) { Pass 'PHP publishes through the internal Nchan endpoint' } else { Fail 'PHP failed to publish through the internal Nchan endpoint' }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $sseText = @(Receive-Job -Job $SseJob -Keep) -join "`n"
        if ($sseText.Contains($token)) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($sseText.Contains('event: changed') -and $sseText.Contains($token) -and $sseText.Contains($channel)) { Pass 'EventSource receives the wildcard Nchan event with its payload' } else { Fail 'EventSource did not receive the expected Nchan event' }
    Stop-Job -Job $SseJob -ErrorAction SilentlyContinue
    Remove-Job -Job $SseJob -Force -ErrorAction SilentlyContinue
    $SseJob = $null

    foreach ($service in @('nginx', 'php-fpm', 'control', 'opencode')) {
        $after = Get-RestartCount $service
        if ((Test-ContainerRunning $service) -and $null -ne $restartCounts[$service] -and $restartCounts[$service] -eq $after) { Pass "$service remained stable during the test" } else { Fail "$service restarted or stopped during the test" }
    }
}
catch {
    Fail $_.Exception.Message
}
finally {
    if ($null -ne $SseJob) {
        Stop-Job -Job $SseJob -ErrorAction SilentlyContinue
        Remove-Job -Job $SseJob -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $Client) { $Client.Dispose() }
    if (Test-Path -LiteralPath $TempDirectory) { Remove-Item -LiteralPath $TempDirectory -Recurse -Force }
}

Write-Output ""
Write-Output "$Passes passed, $Failures failed, $Skips skipped"
if ($Failures -gt 0) { exit 1 }
exit 0
