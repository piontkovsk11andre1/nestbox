<?php
declare(strict_types=1);

require_once __DIR__ . '/init.php';
require_once '/home/code/__includes/functions.php';

$pagesDir = '/home/code';
$route = $argv[1] ?? '';

if ($route === '' || !preg_match('#^[A-Za-z0-9/_-]+$#', $route)) {
    fwrite(STDERR, "Usage: php /sources/php/cli.php <route> [arguments...]\n");
    exit(2);
}

foreach (explode('/', $route) as $segment) {
    if (str_starts_with($segment, '__')) {
        fwrite(STDERR, "Internal super-document routes cannot be executed.\n");
        exit(1);
    }
}

$realPagesDir = realpath($pagesDir);
$pagePath = realpath($pagesDir . '/' . $route . '.php');

if (!$realPagesDir || !$pagePath || !is_file($pagePath) || !str_starts_with($pagePath, $realPagesDir . DIRECTORY_SEPARATOR)) {
    fwrite(STDERR, "Super-document not found: $route\n");
    exit(1);
}

// Present only page-specific arguments to the super-document.
$argv = array_merge([$pagePath], array_slice($argv, 2));
$argc = count($argv);
require $pagePath;
