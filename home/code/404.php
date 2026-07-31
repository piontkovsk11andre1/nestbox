<?php
declare(strict_types=1);

// HTTP direction: preserve and validate the unresolved URI across the form POST.
$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$rawRequestedUri = $method === 'POST'
    ? (string) ($_POST['requested_uri'] ?? '')
    : (string) ($_SERVER['NESTBOX_ORIGINAL_URI'] ?? $_SERVER['REQUEST_URI'] ?? '/');
$pageContext = nestbox_page_context($rawRequestedUri);
$requestedUri = $pageContext['requestedUri'] ?? '';
$requestedPath = $pageContext['requestedPath'] ?? '';
$agentDirectory = $pageContext['agentDirectory'] ?? '';

if (PHP_SAPI === 'cli') {
    echo "Implementation sessions are managed by OpenCode.\n";
    exit;
}

$error = '';
$submittedPrompt = '';

if ($method === 'POST') {
    if ($pageContext === null) {
        http_response_code(422);
        $error = 'This URI cannot map to a Nestbox super-document.';
    } elseif (($_POST['action'] ?? '') !== 'start') {
        http_response_code(400);
        $error = 'Unknown form action.';
    } else {
        $submittedPrompt = trim((string) ($_POST['prompt'] ?? ''));
        $singleLinePrompt = preg_replace('/\s+/u', ' ', $submittedPrompt);
        $submittedPrompt = is_string($singleLinePrompt) ? $singleLinePrompt : '';

        if (!is_string($singleLinePrompt)
            || $singleLinePrompt === ''
            || strlen($singleLinePrompt) > 4000
            || preg_match('//u', $singleLinePrompt) !== 1
        ) {
            http_response_code(422);
            $error = 'Enter a valid one-line UTF-8 request between 1 and 4,000 bytes.';
        } else {
            try {
                // OpenCode scopes the new session to the directory where the
                // requested super-document will live.
                $localDirectory = '/home/code' . substr($agentDirectory, strlen('/nestbox/home/code'));
                if (!is_dir($localDirectory) && !mkdir($localDirectory, 0775, true) && !is_dir($localDirectory)) {
                    throw new RuntimeException('Nestbox could not create the super-document directory.');
                }

                $title = preg_match('/^.{0,72}/us', $singleLinePrompt, $titleMatch) === 1
                    ? $titleMatch[0]
                    : 'New page';
                $session = nestbox_opencode_create_session('Nestbox ' . $requestedPath . ': ' . $title, $agentDirectory);
                if (isset($session['directory'])
                    && (!is_string($session['directory']) || $session['directory'] !== $agentDirectory)
                ) {
                    throw new RuntimeException('OpenCode created the session in an unexpected directory.');
                }

                $sessionId = (string) $session['id'];
                $agentPrompt = 'Requested Nestbox page URI: ' . $requestedUri
                    . '. Implement this route as a cohesive super-document under /nestbox/home/code, following /nestbox/home/configs/opencode/instructions.md. Do not modify unrelated projects under /workspace. Request: '
                    . $singleLinePrompt;
                nestbox_opencode_prompt_async($sessionId, $agentPrompt, '', $agentDirectory);

                header('Location: ' . nestbox_opencode_session_url($sessionId, $agentDirectory), true, 303);
                exit;
            } catch (Throwable $exception) {
                http_response_code(502);
                $error = $exception->getMessage();
            }
        }
    }
} else {
    http_response_code(404);
}

$formAction = nestbox_url_path('404');
?>
---
title: Page not found
---

# Page not found

Nestbox could not resolve `<?= nestbox_escape($requestedUri); ?>`.

<?php if ($error !== ''): ?>
<div class="alert alert-danger" role="alert"><?= nestbox_escape($error); ?></div>
<?php endif; ?>

<?php if ($pageContext !== null): ?>
<form class="card card-body" method="post" action="<?= nestbox_escape($formAction); ?>" target="nestbox-opencode">
  <input type="hidden" name="action" value="start">
  <input type="hidden" name="requested_uri" value="<?= nestbox_escape($requestedUri); ?>">
  <label class="form-label" for="prompt">Ask OpenCode to implement this page</label>
  <input class="form-control" id="prompt" name="prompt" type="text" maxlength="4000" value="<?= nestbox_escape($submittedPrompt); ?>" required>
  <div class="mt-3">
    <button class="btn btn-primary" type="submit">Create and open session</button>
  </div>
</form>
<?php else: ?>
<div class="alert alert-secondary" role="status">This URI cannot map to a Nestbox super-document.</div>
<?php endif; ?>
