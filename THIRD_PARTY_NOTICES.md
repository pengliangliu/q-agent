# Third-party notices

## Agent Deck

This project extends and contains modified portions of [asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck), targeting tag `v1.16.35`.

Copyright (c) 2025 Ashesh Goplani. Licensed under the MIT License. The full upstream copyright and license text are retained in this repository's `LICENSE`.

The frontend overrides use the upstream web application's existing Preact/HTM, terminal, styling and other runtime dependencies. Their original resources and notices remain supplied by the installed upstream application. This repository does not republish the upstream dependency caches or minified vendor bundle.

## Microsoft WebView2

The desktop build script downloads `Microsoft.Web.WebView2` version `1.0.4314.35` from the official NuGet feed. The SDK and runtime are governed by Microsoft's terms, not this repository's MIT license. SDK packages and binaries are excluded from Git. A local build copies the package's `LICENSE.txt` and `NOTICE.txt` into its distribution alongside redistributed DLLs.

## Assistant CLIs

Claude Code and Codex CLI are separately installed applications with their own licenses, service terms and authentication. They are not bundled with this repository. Slash-command catalogs describe their version-specific command names and cite their sources; they contain no account configuration or credentials.

## Project icon

The penguin icons under `desktop-files/web-ui/overrides/static/icons/` and `favicon.ico` retain the project's chosen visual identity and are derived from supplied reference artwork. They are excluded from the MIT license grant for the code. No ownership of third-party artwork or trademarks, or separate permission for reuse of those rights, is asserted here. Before reusing the artwork in another project or product, obtain any required permission from the relevant rights holder.
