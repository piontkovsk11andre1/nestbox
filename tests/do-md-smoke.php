<?php
declare(strict_types=1);

require_once getenv('NESTBOX_TEST_FUNCTIONS') ?: '/home/code/__includes/functions.php';
$documents = str_replace('\\', '/', getenv('NESTBOX_DO_MD_TEST_DOCUMENTS') ?: '/documents');
$check = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$health = nestbox_do_md_health();
$capabilities = nestbox_do_md_capabilities();
$check($health['apiVersion'] === 1 && count($capabilities['commands']) >= 8, 'Missing do-md API contract.');

foreach (['workspace', 'pages'] as $tree) {
    // These unpredictable private fixture directories are owned by this test;
    // no project document is overwritten or removed, even on failure.
    $directory = $documents . '/' . $tree . '/__nestbox_do_md_php_' . bin2hex(random_bytes(8));
    if (!mkdir($directory, 0700)) {
        throw new RuntimeException('Cannot create shared do-md fixture.');
    }
    try {
        file_put_contents($directory . '/doc.md', "# Before\r\n");
        file_put_contents($directory . '/doc.tpl.md', '# {% doc.line().as("title") %}' . "\r\n");
        file_put_contents($directory . '/other.tpl.md', 'Title: {% doc.line().as("title") %}' . "\n");
        file_put_contents($directory . '/query.md', '{% doc.query(d => { d.literal("# "); d.line().as("title") }); doc.rawRest() %}');
        $params = ['file' => 'doc.md', 'template' => 'doc.tpl.md'];
        $check(nestbox_do_md_validate($params, $directory)['ok'], 'PHP cannot validate its shared file.');
        $exported = nestbox_do_md_export($params + ['savePath' => 'export.json'], $directory);
        $check($exported['ok'] && $exported['context']['title'] === 'Before', 'Incorrect exported context.');
        $check(json_decode(file_get_contents($directory . '/export.json'), true)['title'] === 'Before', 'Remote export is not visible in PHP.');
        $created = nestbox_do_md_create(['template' => 'doc.tpl.md', 'file' => 'created.md', 'data' => ['title' => 'Created']], $directory);
        $check($created['ok'] && str_starts_with(file_get_contents($directory . '/created.md'), '# Created'), 'Remote creation is not visible in PHP.');
        $check(fileowner($directory . '/created.md') === fileowner($directory . '/doc.md'), 'do-md and PHP file ownership differs.');
        $duplicate = nestbox_do_md_create(['template' => 'doc.tpl.md', 'file' => 'created.md', 'data' => []], $directory);
        $check(!$duplicate['ok'], 'Create unexpectedly overwrote an existing file.');
        $dry = nestbox_do_md_set($params + ['key' => 'title', 'value' => 'Dry', 'dryRun' => true], $directory);
        $check($dry['ok'] && file_get_contents($directory . '/doc.md') === "# Before\r\n", 'Dry run changed the file.');
        $changed = nestbox_do_md_set($params + ['key' => 'title', 'value' => 'After'], $directory);
        $check($changed['ok'] && file_get_contents($directory . '/doc.md') === "# After\r\n", 'Set did not preserve CRLF bytes.');
        $rendered = nestbox_do_md_render(['file' => 'doc.md', 'parseTemplate' => 'doc.tpl.md', 'renderTemplate' => 'other.tpl.md', 'outFile' => 'rendered.md'], $directory);
        $check($rendered['ok'] && trim(file_get_contents($directory . '/rendered.md')) === 'Title: After', 'Remote render failed.');
        $matched = nestbox_do_md_match(['file' => 'doc.md', 'templates' => '*.tpl.md', 'all' => true], $directory);
        $check($matched['ok'] && count($matched['matches']) >= 1, 'Remote template discovery failed.');
        $queried = nestbox_do_md_query(['file' => 'doc.md', 'template' => 'query.md', 'all' => true], $directory);
        $check($queried['ok'] && $queried['matches'][0]['context']['title'] === 'After', 'Remote query failed.');
        $reference = nestbox_do_md_reference([], $directory);
        $check($reference['ok'] && isset($reference['reference']['functions']), 'Empty PHP params were not sent as a JSON object.');
        $escape = nestbox_do_md_validate(['file' => '../outside.md', 'template' => 'doc.tpl.md'], $directory);
        $check(!$escape['ok'] && str_contains($escape['errors'][0]['message'], 'escapes'), 'Directory containment was not enforced.');
    } finally {
        foreach (array_diff(scandir($directory), ['.', '..']) as $name) {
            unlink($directory . '/' . $name);
        }
        rmdir($directory);
    }
}
echo 'do-md ' . $health['version'] . ": PHP helpers, ownership, and both shared mounts verified\n";
