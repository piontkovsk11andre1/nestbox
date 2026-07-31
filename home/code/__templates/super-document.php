<?php
// CLI direction: expose the document's focused command-line behavior.
if (PHP_SAPI === 'cli') {
    $name = trim($argv[1] ?? 'workspace');
    echo "Hello, $name!\n";
    exit;
}

// HTTP direction: process mutations before emitting frontmatter or Markdown.
$name = trim((string) ($_POST['name'] ?? 'workspace'));
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    // Publish only an invalidation hint after the request state is accepted.
    nestbox_bus_publish('example:greeting', 'changed', ['name' => $name]);
}
?>
---
title: Super-document
---

# Hello, <?= nestbox_escape($name); ?>

This page keeps its HTTP processing, Markdown, interface, and browser behavior together.

<?php // Keep related element tags in one raw HTML block without empty lines between them. ?>
<form class="card card-body" method="post"><label class="form-label" for="name">Name</label><div class="input-group"><input class="form-control" id="name" name="name" value="<?= nestbox_escape($name); ?>"><button class="btn btn-primary" type="submit">Greet</button></div></form>

<p class="alert alert-success mt-3" id="greeting">Hello, <?= nestbox_escape($name); ?>!</p>

<p class="small text-body-secondary" id="event-status">Waiting for greeting changes.</p>

<script>
// Browser direction: local input feedback remains page-specific and immediate.
const nameInput = document.querySelector('#name');
const greeting = document.querySelector('#greeting');
const eventStatus = document.querySelector('#event-status');
nameInput.addEventListener('input', () => {
    greeting.textContent = `Hello, ${nameInput.value || 'workspace'}!`;
});

// One EventSource carries this page's server-side invalidations.
const events = new EventSource(<?= nestbox_script_json(nestbox_bus_url('example:greeting')); ?>);
events.addEventListener('changed', ({data}) => {
    const message = JSON.parse(data);
    eventStatus.textContent = `Greeting changed to ${message.data.name || 'workspace'} in another request.`;
});
window.addEventListener('pagehide', () => events.close(), {once: true});
</script>
