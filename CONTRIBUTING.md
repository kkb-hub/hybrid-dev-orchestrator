# Contributing to Hybrid Dev Orchestrator

Thanks for your interest. This document covers what you need to build, test, and
submit a change.

> **Note on language.** This file, the README, and all agent-facing surfaces
> (`commands/*.md`, `skills/*/SKILL.md`, JSON Schema descriptions, CLI help) are in
> English. The detailed design documents under `docs/` — including both ADRs — are
> written in Japanese. Issues and pull requests are welcome in either language.

## Prerequisites

- **Windows 11.** This is the only supported platform today. WSL2 and Linux are not
  yet supported targets (see [ADR-0001](docs/adr/0001-primary-runtime-typescript.md)).
- **Node.js 24 or later** — the primary runtime.
- **PowerShell 7.2 or later** (`pwsh`). Running HDO no longer requires it, but the
  PowerShell regression suite is a required CI check, so you need `pwsh` to reproduce
  that gate locally. Windows PowerShell 5.1 will not work.
- **Git for Windows**, and the **GitHub CLI** (`gh`) authenticated via `gh auth login`.
- Optional, depending on what you touch: the `claude`, `codex`, or `ollama` CLIs.

```sh
npm ci
```

`npm ci` is required even for plugin use — the TypeScript CLI depends on `ajv`,
`ajv-formats`, and `koffi`, and `node_modules/` is gitignored.

## Which runtime should I write in?

The project is mid-migration per [ADR-0001](docs/adr/0001-primary-runtime-typescript.md).

- **New work goes in TypeScript** under `src/core/`, `src/platform/`, `src/process/`,
  `src/git/`, `src/github/`, `src/runners/`, `src/workflow/`, `src/cli/`.
- **The PowerShell implementation (`hdo.ps1`, `src/HybridDevOrchestrator/`) is in
  maintenance mode** — bug fixes to existing behaviour only, no new subsystems.

Architecture and dependency direction are described in `docs/architecture.md` §16.

### Import boundaries

`koffi` (used for Win32 Job Objects, see
[ADR-0002](docs/adr/0002-windows-job-object-via-koffi.md)) may only be imported from
`src/platform/**`. `src/core/**` must not import it. This is enforced mechanically by
`src/core/boundary.test.ts` — it will fail your build, not just your review.

## Running the tests

```sh
npm run typecheck
npm test
```

```powershell
pwsh -NoProfile -File ./tests/test-suite.ps1      # full PowerShell regression suite
pwsh -NoProfile -File ./tests/test-schemas.ps1    # JSON Schema and example validation
pwsh -NoProfile -File ./tests/test-plugin.ps1     # plugin manifest validation
```

Smoke tests that need a live provider (`tests/test-ollama-smoke.ps1`,
`tests/test-lean-worker-smoke.ps1`) are not part of the default gate.

> The PowerShell suite creates deeply nested worktrees. Run it from a short path — a
> checkout nested several directories deep can hit the Windows path-length limit and
> fail for reasons unrelated to your change.

## Bumping the plugin version

CI **will fail your PR** if you change the distribution surface without bumping both
plugin manifests in lockstep. The watched paths are `hdo.ps1`, `src/`, `commands/`,
`skills/`, `config/`, and `schemas/`.

If you touched any of those, bump `version` in **both**:

- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`

Keep `package.json` and `src/HybridDevOrchestrator/HybridDevOrchestrator.psd1`
(`ModuleVersion`) on the same number. Check locally before pushing:

```powershell
pwsh -NoProfile -File ./tools/check-plugin-version.ps1 -BaseRef origin/main -HeadRef HEAD
```

## Pull requests

- Branch off `main`.
- Keep the change focused; unrelated cleanups belong in their own PR.
- Add or update tests. The existing suites are the reference for style.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- Make sure `npm run typecheck`, `npm test`, and `tests/test-suite.ps1` pass.
- All four CI workflows must be green: `test-suite`, `typescript`, `poc-typescript`,
  `plugin-version`.

Design decisions of any weight should be recorded as an ADR in `docs/adr/` rather than
buried in a PR description.

## Reporting bugs and requesting features

Use the **Bug report** or **Feature request** issue templates.

The **HDO implementation task** template is *not* for reporting problems with this
project — it is the product's own issue contract form, meant to be copied into
repositories you run HDO against.

Security vulnerabilities: do not open an issue. See [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
