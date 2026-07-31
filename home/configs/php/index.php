<?php
require_once __DIR__ . '/init.php';
require_once '/home/code/__includes/functions.php';

use League\CommonMark\Environment\Environment;
use League\CommonMark\Extension\CommonMark\CommonMarkCoreExtension;
use League\CommonMark\Extension\FrontMatter\FrontMatterExtension;
use League\CommonMark\Extension\FrontMatter\Output\RenderedContentWithFrontMatter;
use League\CommonMark\Extension\GithubFlavoredMarkdownExtension;
use League\CommonMark\Extension\HeadingPermalink\HeadingPermalinkExtension;
use League\CommonMark\MarkdownConverter;

$pagesDir = '/home/code';
$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if ($requestPath === '/_nestbox/health') {
    header('Content-Type: application/json; charset=UTF-8');
    echo '{"status":"ok"}';
    exit;
}

$route = trim(preg_replace('#/+#', '/', $requestPath), '/');
if ($route === '') {
    $route = 'index';
}

$markdownOutput = str_ends_with(strtolower($route), '.md');
if ($markdownOutput) {
    $route = substr($route, 0, -3);
}

if (!preg_match('#^[A-Za-z0-9/_-]+$#', $route)) {
    http_response_code(400);
    exit;
}

foreach (explode('/', $route) as $segment) {
    if (str_starts_with($segment, '__')) {
        http_response_code(404);
        exit;
    }
}

$environment = new Environment([
    'html_input' => 'allow',
    'allow_unsafe_links' => false,
    // Super-documents are trusted and may use script, style, and form elements.
    'disallowed_raw_html' => [
        'disallowed_tags' => [],
    ],
    'heading_permalink' => [
        'symbol' => '¶',
        'insert' => 'after',
        'min_heading_level' => 2,
        'max_heading_level' => 4,
    ],
]);
$environment->addExtension(new CommonMarkCoreExtension());
$environment->addExtension(new GithubFlavoredMarkdownExtension());
$environment->addExtension(new FrontMatterExtension());
$environment->addExtension(new HeadingPermalinkExtension());
$markdown = new MarkdownConverter($environment);

$realPagesDir = realpath($pagesDir);
$phpPath = realpath($pagesDir . '/' . $route . '.php');
$markdownPath = realpath($pagesDir . '/' . $route . '.md');
$sourcePath = $markdownOutput && $markdownPath && is_file($markdownPath)
    ? $markdownPath
    : ($phpPath && is_file($phpPath) ? $phpPath : ($markdownPath && is_file($markdownPath) ? $markdownPath : false));

if (!$realPagesDir || !$sourcePath || !str_starts_with($sourcePath, $realPagesDir . DIRECTORY_SEPARATOR)) {
    http_response_code(404);
    exit;
}

if (str_ends_with(strtolower($sourcePath), '.php')) {
    ob_start();
    include $sourcePath;
    $content = ob_get_clean();
} else {
    $content = file_get_contents($sourcePath);
    if ($content === false) {
        http_response_code(500);
        exit;
    }
}

if ($markdownOutput) {
    header('Content-Type: text/markdown; charset=UTF-8');
    echo $content;
    exit;
}

$rendered = $markdown->convert($content);
$title = 'Nestbox';
if ($rendered instanceof RenderedContentWithFrontMatter) {
    $frontMatter = $rendered->getFrontMatter();
    if (is_array($frontMatter) && isset($frontMatter['title']) && is_string($frontMatter['title'])) {
        $title = $frontMatter['title'];
    }
}

require $pagesDir . '/__includes/header.php';
echo $rendered->getContent();
require $pagesDir . '/__includes/footer.php';
