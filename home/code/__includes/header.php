<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title><?= htmlspecialchars($title ?? 'Nestbox', ENT_QUOTES, 'UTF-8'); ?></title>
        <!-- Pre-built bundle of every shared dependency (Bootstrap, GitHub Markdown CSS, …): -->
        <link rel="stylesheet" href="<?= nestbox_escape(nestbox_url_path('scripts-bundle.css')); ?>">
        <script defer src="<?= nestbox_escape(nestbox_url_path('scripts-bundle.js')); ?>"></script>
        <!-- Site-wide overrides: -->
        <link rel="stylesheet" href="<?= nestbox_escape(nestbox_url_path('styles.css')); ?>">
    </head>
    <body>
        <header class="nestbox-toolbar navbar fixed-top bg-body-tertiary border-bottom px-3" aria-label="Page tools">
            <a class="navbar-brand fs-6 fw-semibold mb-0" href="<?= nestbox_escape(nestbox_url_path()); ?>">Nestbox</a>
            <div class="d-flex align-items-center gap-2 ms-auto">
                <a class="btn btn-sm btn-secondary" href="<?= nestbox_escape(nestbox_opencode_origin()); ?>" target="nestbox-opencode">Open Chat</a>
            </div>
        </header>
        <article class="markdown-body">
