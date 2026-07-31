# Nestbox Instance Policy

The installer copies this template to `instance.md` and updates it before startup so the internal agent knows how to work with this installation without reading `.env`.

- Layout: current directory.
- Communication language: English.
- Interface language: English; no additional i18n setup requested.
- Engine: `/nestbox` is the complete Nestbox installation.
- Page tree: `/nestbox/home/code` belongs to the same installation.
- Workspace: `/workspace` maps to the installation directory.
- Git ownership: the repository containing `/nestbox` owns reasonable Nestbox source and infrastructure changes throughout the installation.
- Upstream source revision: record during installation.
- Commit policy: unconfigured; ask before any commit until the installer replaces this line with the user's automatic, per-commit confirmation, or no-commit choice.
- Never commit credentials or incidental state, include unrelated changes, or push without explicit approval.

For an installation at `<workspace>/.nestbox`, the installer changes the layout and workspace lines while retaining `/nestbox/home/code` and the installation's own Git repository. It also records the user's language, translation or i18n request, and installation-time commit choice. Non-default ownership or page paths are recorded only when explicitly requested.
