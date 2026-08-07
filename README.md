# Nestbox

## Introduction

Nestbox is an agent-guided workspace for building focused interfaces around projects, tools, data, and containerized services.

Its core design is the **super-document**: one cohesive PHP and Markdown document can provide server logic, command-line behavior, forms, HTML, and browser JavaScript. The internal OpenCode agent creates and extends these documents, integrates project runtimes, and prepares infrastructure changes.

Nestbox runs with Docker Compose using Nginx, PHP-FPM, Rollup, and OpenCode. A fresh installation opens with a prompt for creating its first screen instead of shipping a predefined application.

## Learn More

Copy and send this to an agent with web access:

```text
Learn about Nestbox from https://github.com/piontkovsk11andre1/nestbox. Read its current documentation and explain its super-document design, agent workflow, container integration model, best use cases, and limitations. Do not install or modify anything.
```

## Installation

Create a new Nestbox project with npm:

```sh
npm create @p10i/nestbox@latest
```

The creator offers the two default layouts: install directly into the selected directory or install at `<workspace>/.nestbox`. After creation, edit `.env`, then run the Docker Compose validation and startup commands printed by the creator.

For agent-guided installation or repair work, copy and send this to an agent with filesystem, Git, Docker, and terminal access:

```text
Install Nestbox by following https://github.com/piontkovsk11andre1/nestbox/blob/main/INSTALL.md completely. Ask all required questions before making changes, preserve unrelated files and Git history, and do not expose secrets.
```

## Update

Run an update request from the workspace containing Nestbox, then copy and send this prompt to an agent with filesystem, Git, Docker, and terminal access:

```text
Update this Nestbox installation from https://github.com/piontkovsk11andre1/nestbox. Locate the installation, inspect its local Git history and configuration, read the current remote INSTALL.md and internal Nestbox instructions, preserve pages, instance policy, secrets, volumes, and unrelated changes, explain the proposed update, and ask before destructive or system-level operations. Validate Compose and run the Nestbox host tests after applying the update.
```
