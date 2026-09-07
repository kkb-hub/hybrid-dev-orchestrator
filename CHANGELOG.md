# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The authoritative version number is the one in `.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json`; `package.json` and
`src/HybridDevOrchestrator/HybridDevOrchestrator.psd1` are kept in step with it.

## [Unreleased]

## [0.14.0] - 2026-09-07

First public release. No functional changes — this release prepares the project
for open-source distribution.

### Added

- MIT `LICENSE`, and `license` metadata in `package.json`,
  `poc/typescript/package.json`, `poc/ai-sdk/package.json`, and both plugin
  manifests.
- `LicenseUri` in the PowerShell module manifest.
- `SECURITY.md`, documenting the threat model and what HDO does and does not
  enforce, plus private vulnerability reporting.
- `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.
- English `README.md`; the Japanese original is preserved as `README.ja.md`.
- Bug report and feature request issue templates, a pull request template,
  `CODEOWNERS`, and Dependabot configuration.
- `.gitattributes` pinning CRLF for PowerShell sources and LF elsewhere.

### Changed

- Aligned `package.json`, the PowerShell module manifest, and both plugin
  manifests on a single version number.
- PowerShell module copyright changed from "All rights reserved" to the MIT
  license, which the previous wording contradicted.
- `.gitignore` now covers `.claude/`, `.env*`, and editor/OS artifacts. `.claude/`
  was previously excluded only through the local, unshared `.git/info/exclude`.

## [0.13.0] and earlier

Developed privately. See the commit history and `docs/adr/` for the migration
record, in particular
[ADR-0001](docs/adr/0001-primary-runtime-typescript.md) (phased migration from
PowerShell to TypeScript/Node.js) and
[ADR-0002](docs/adr/0002-windows-job-object-via-koffi.md) (Win32 Job Objects via
koffi).

[Unreleased]: https://github.com/kkb-hub/hybrid-dev-orchestrator/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/kkb-hub/hybrid-dev-orchestrator/releases/tag/v0.14.0
