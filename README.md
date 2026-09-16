# Hybrid Dev Orchestrator

**English** | [日本語](README.ja.md)

Hybrid Dev Orchestrator (HDO) is a Windows CLI that normalizes a GitHub Issue into an
implementation contract, then runs a bounded planning → implementation → validation →
review → fix cycle inside a dedicated Git worktree.

Each AI step is configured as a *runner*. The default is a claude-only setup using the
Claude Code CLI; neither Codex nor Ollama is required. A `.hdo/config.json` committed
to the target repository sets the default provider and model for each of the plan,
implement, review, and fix steps.

> **Documentation language.** This README is a translation. The detailed design
> documents under [`docs/`](docs/) — including both ADRs — are written in Japanese, and
> so is [README.ja.md](README.ja.md). The agent-facing surfaces (`commands/*.md`,
> `skills/*/SKILL.md`, JSON Schema descriptions, and CLI help) are in English.

## Requirements

- Windows 11
- Node.js 24 LTS, with `npm ci` run once in the checkout. Per
  [ADR-0001](docs/adr/0001-primary-runtime-typescript.md) the runtime is migrating to
  TypeScript/Node.js in phases; the CLI and both plugins now run on Node.
- PowerShell 7.2 or later (`pwsh`) is **optional** as of phase 8 — no route of the
  TypeScript runtime requires it. You need it only to run the PowerShell regression
  suite, to use the maintenance-mode `hdo.ps1`, or if your config explicitly launches
  the PowerShell worker. The Windows-bundled PowerShell 5.1 will not work; install
  `pwsh` separately.
- WSL2 and Linux are not supported targets. The migration's first target is Windows.
- Git for Windows
- GitHub CLI `gh`, authenticated
- For the default setup, the Claude Code CLI `claude` and its authentication (OAuth
  login via `claude`, or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` added
  explicitly to the runner's `passEnvironment`)
- A reviewed `.hdo/project.json` in the target repository
- A reviewed and committed `.hdo/config.json`, if you want repository-specific routing
- The HDO Issue Form and labels in the target GitHub repository

Codex and Ollama are optional. Codex requires the `codex` command and cloud
authentication only if you select it, for example via
`config/examples/cloud-only.json`. The Ollama hybrid route needs the `ollama` command,
the service, and the configured model, plus the `claude` command as a local tool
harness. That route calls no Anthropic endpoint and no Claude model — HDO pins a
loopback Ollama Anthropic-compatible endpoint. HDO does not pull models automatically.

## Try it in five minutes

The examples below assume the HDO checkout and the target repository live in separate
directories.

```powershell
$hdo = 'C:\src\hybrid-dev-orchestrator\hdo.ps1'
$repoPath = 'C:\src\owner\target-repository'
$repo = 'owner/target-repository'

gh auth login
gh auth status
```

### 1. Prepare the target repository

Commit the following into the target repository:

- `.hdo/project.json` — validation gates and project policy
- `.github/ISSUE_TEMPLATE/hdo-task.yml` — the Issue Form for HDO tasks

This repository's [.hdo/project.json](.hdo/project.json) and
[.github/ISSUE_TEMPLATE/hdo-task.yml](.github/ISSUE_TEMPLATE/hdo-task.yml) are a
reasonable starting point. Validation commands are defined **only** in
`.hdo/project.json`, never in an issue body. Review the contents before running
anything.

Check the configuration and the read-only preflight:

```powershell
pwsh -NoProfile -File $hdo config `
  -RepositoryPath $repoPath -Json

pwsh -NoProfile -File $hdo doctor `
  -RepositoryPath $repoPath -DryRun
```

The default profile is `claude-only`. Even under `doctor -DryRun`, HDO reads GitHub,
the runners, the selected local provider, and the project contract — but it creates no
path probe files.

### 2. Set up labels

The first command only shows the diff; adding `-Apply` creates and updates labels.

```powershell
pwsh -NoProfile -File $hdo labels `
  -RepositoryPath $repoPath -Repository $repo

pwsh -NoProfile -File $hdo labels `
  -RepositoryPath $repoPath -Repository $repo -Apply
```

HDO synchronizes `hdo:ready`, the mutually exclusive `hdo:status/*`, the priority and
risk labels, and the `hdo:route/*` labels matching the configured profiles. Labels
outside the HDO namespace are left alone.

### 3. Create an issue

In GitHub's New Issue screen, choose **HDO implementation task** and fill in at least:

- Problem / Context
- Goal
- Acceptance Criteria
- In Scope
- Validation Gate IDs
- Priority and Risk

Validation Gate IDs must reference IDs that exist in `.hdo/project.json`. Commands in
the issue body are never executed.

Once a maintainer has reviewed the contents and the dependencies, they add
`hdo:ready`:

```powershell
$issue = 123
gh issue edit $issue --repo $repo --add-label 'hdo:ready'
```

The Issue Form does not apply `hdo:ready` on its own.

### 4. Read and dry-run

```powershell
pwsh -NoProfile -File $hdo issues `
  -RepositoryPath $repoPath -Repository $repo

pwsh -NoProfile -File $hdo inspect -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo -Json

pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo -DryRun -Json
```

`run -DryRun` checks the issue contract, the profile, step routing, the project
contract, and the preflight, then returns an execution plan. It creates no worktree,
no run artifacts, no claim comment, no labels, no assignee, and starts no AI runner
process.

### 5. Run it

A normal run, writing claim and status back to GitHub:

```powershell
pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo
```

The same implementation / validation / review cycle without modifying GitHub:

```powershell
pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo -NoWriteBack
```

For automatic pickup, use `-Pick` instead of `-Issue`:

```powershell
pwsh -NoProfile -File $hdo run -Pick `
  -RepositoryPath $repoPath -Repository $repo -DryRun -Json
```

Pickup orders eligible issues deterministically by priority, creation time, and issue
number. Passing `-Issue` explicitly does not skip the checks for open state,
`hdo:ready`, the required sections, or the validation gates.

## DryRun and NoWriteBack

| Behaviour | Normal run | `-DryRun` | `-NoWriteBack` |
|---|:---:|:---:|:---:|
| Reads GitHub / the issue | yes | yes | yes |
| Issue contract, config, preflight | yes | yes | yes |
| Runs the AI runners | yes | no | yes |
| Creates worktree / run artifacts | yes | no | yes |
| Validation / review / fix | yes | no | yes |
| Claim comment, status label, assignee | yes | no | no |

`-NoWriteBack` is **not** a dry run. It is a full cycle that modifies code and leaves
uncommitted changes in a dedicated worktree.

## Per-repository model routing

If the target repository's `HEAD` contains `.hdo/config.json`, HDO loads it
automatically for the ordinary `config`, `doctor`, and `run` commands. From a plugin,
a normal run is therefore just:

```text
/hdo:run -Issue 123
```

Automatic configuration is validated against a restricted schema. It can change only
profile routing and the provider, model, sandbox, timeout, and similar fields of the
built-in Codex and Claude runners. Arbitrary commands, arguments, environment,
storage locations, GitHub write-back, and fallback policy **cannot** be changed from
repository configuration. If `.hdo/config.json` exists only in the working tree and
not in `HEAD`, HDO fails closed rather than applying it. Repositories without the file
keep working on the default configuration.

[config/examples/repository-ollama-hybrid.json](config/examples/repository-ollama-hybrid.json)
is an example for a Codex parent that routes only the implementation step to Ollama.
Place it in the target repository as `.hdo/config.json` and commit it.

```powershell
$hdoRoot = Split-Path -Parent $hdo
New-Item -ItemType Directory (Join-Path $repoPath '.hdo') -Force | Out-Null
Copy-Item (Join-Path $hdoRoot 'config/examples/repository-ollama-hybrid.json') `
  (Join-Path $repoPath '.hdo/config.json')

git -C $repoPath add .hdo/config.json
git -C $repoPath commit -m 'Configure HDO Ollama implementation runner'

pwsh -NoProfile -File $hdo config -RepositoryPath $repoPath -Json
pwsh -NoProfile -File $hdo run -Issue $issue -RepositoryPath $repoPath -Repository $repo
```

That example assigns plan and review to the current Codex cloud model, and implement
and fix to Ollama's `qwen3.8:27b-q4_K_M`. The `claude` command in the local steps acts
only as a tool harness; it uses no Anthropic authentication or quota. If Ollama is
unavailable, HDO does **not** fall back to the cloud.

To use a different configuration temporarily, pass `-Config` explicitly. Multiple
files are comma-separated and merged left to right, with later files winning. Relative
paths resolve against the target repository root.

```text
/hdo:run -Issue 123 -Config ./.hdo/alternate.json
/hdo:run -Issue 123 -Config ./.hdo/base.json,./.hdo/local.json
/hdo:run -Issue 123 -IgnoreRepositoryConfig -Config ./.hdo/alternate.json
```

`-IgnoreRepositoryConfig` disables only the automatic `.hdo/config.json`. An explicit
`-Config` is treated as a reviewed full configuration, so it may also set the
user-authorized runner options that automatic configuration forbids.

## Claude-only, Codex cloud, and Ollama hybrid

The default [config/hdo.default.json](config/hdo.default.json) assigns every step to
the Claude runner and probes neither Codex nor Ollama, so it works on a machine with
only Claude installed. To pin models explicitly, use
[config/examples/claude-only.json](config/examples/claude-only.json) (`opus` for plan
and review, `sonnet` for implement and fix).

To use Codex temporarily, name
[config/examples/cloud-only.json](config/examples/cloud-only.json) explicitly:

```powershell
$codexConfig = 'C:\src\hybrid-dev-orchestrator\config\examples\cloud-only.json'

pwsh -NoProfile -File $hdo doctor `
  -RepositoryPath $repoPath -Config $codexConfig `
  -Profile cloud-only -DryRun
```

The explicitly loaded Ollama hybrid configuration
[config/examples/ollama-hybrid.json](config/examples/ollama-hybrid.json) likewise puts
plan and review in the cloud and implement and fix on Ollama.

```powershell
$hybridConfig = 'C:\src\hybrid-dev-orchestrator\config\examples\ollama-hybrid.json'

pwsh -NoProfile -File $hdo config `
  -RepositoryPath $repoPath -Config $hybridConfig `
  -Profile ollama-hybrid -Json

pwsh -NoProfile -File $hdo doctor `
  -RepositoryPath $repoPath -Config $hybridConfig `
  -Profile ollama-hybrid -DryRun
```

To change the runner for a single step temporarily, name a defined runner:

```powershell
pwsh -NoProfile -File $hdo run -Issue $issue `
  -RepositoryPath $repoPath -Repository $repo `
  -Config $hybridConfig -Profile ollama-hybrid `
  -SetStep implement=claude-ollama-implementer -DryRun -Json
```

There is no implicit provider or model fallback. If the selected runner is
unavailable, HDO stops at the preflight or at that step rather than switching to
another runner.

On a local host with Ollama 0.33.2 or later and the configured model installed, you
can run an opt-in smoke test that sends exactly one request to the real provider. It
is excluded from the normal test suite and from CI. Progress and the final result are
written atomically to `test-results/ollama-smoke-last-result.json`, so the outcome is
recoverable even if the caller's IPC or waiting turn ends first.

```powershell
pwsh -NoProfile -File ./tests/test-ollama-smoke.ps1 -Run
```

Add `-KeepArtifacts` to also retain the temporary repository and the raw envelope for
diagnosis, or `-ResultPath <path>` to change where the receipt is stored.

## CLI

```text
help      Show CLI usage
doctor    Check Git, gh auth, the project contract, the selected runners/providers, and storage
config    Show the execution plan after merging and profile resolution
issues    List pickup candidates
inspect   Show one issue with its normalized contract and validation result
run       Execute a dry run or a full cycle for an issue
status    Read run.json from the artifacts
cleanup   Remove a named run's worktree, subject to safety conditions
labels    Show the label catalog diff, or synchronize it
```

For exact syntax:

```powershell
pwsh -NoProfile -File $hdo help
```

## Artifacts and cleanup

By default HDO stores:

- worktrees in `%LOCALAPPDATA%\hdo\worktrees\<run-id>`
- artifacts in `%LOCALAPPDATA%\hdo\runs\<run-id>`

Where `%LOCALAPPDATA%` is undefined, HDO falls back to the .NET known folder
(see [docs/configuration.md](docs/configuration.md) §9).

A full run emits an `HDO_PROGRESS` JSON record to stderr immediately after creation,
showing the run ID and artifact path, and emits a heartbeat on the same channel every
30 seconds while waiting on an agent subprocess. The final `-Json` result goes to
stdout only, so machine consumers of the JSON are not broken. If the caller's IPC or
waiting turn is lost mid-run, do **not** re-run the same issue — inspect the stored
state using the run ID from the first progress record.

```powershell
pwsh -NoProfile -File $hdo status -RunId '<run-id>' `
  -RepositoryPath $repoPath -Json

pwsh -NoProfile -File $hdo cleanup -RunId '<run-id>' `
  -RepositoryPath $repoPath -Force -WhatIf
```

Worktrees intentionally retain uncommitted changes, so ordinary cleanup refuses to
run. Only after you have reviewed and preserved `final/diff.patch` and any new files
you need should you re-run with `-Force`. Run artifacts and any created branches
survive cleanup.

## Using it as a Claude Code plugin

This repository can be installed as a Claude Code plugin. The plugin is a thin layer
over the TypeScript CLI (`src/cli/main.ts`, launched with `node`) and does not
duplicate any orchestration logic. **Run `npm ci` once in the plugin root before using
it** — Node.js 24 LTS is required, and `node_modules/` is gitignored so it does not
ship with the plugin. The PowerShell implementation (`hdo.ps1`) remains in the
repository in maintenance mode and is not called by the plugin.

```text
claude plugin marketplace add kkb-hub/hybrid-dev-orchestrator
claude plugin install hdo@hybrid-dev-orchestrator
```

Once installed, these slash commands are available in a Claude Code session, with the
target repository open as the working directory:

| Command | Purpose |
|---|---|
| `/hdo:doctor` | Preflight checks |
| `/hdo:config` | Resolved configuration and execution plan |
| `/hdo:issues` | List pickup candidates |
| `/hdo:inspect` | Inspect an issue and its normalized contract |
| `/hdo:run` | Execute a dry run or a full cycle |
| `/hdo:status` | Show run status |
| `/hdo:cleanup` | Remove a run worktree (`-WhatIf` by default) |
| `/hdo:labels` | Diff or synchronize the label catalog |

To try a local checkout, load it with
`claude --plugin-dir C:\src\hybrid-dev-orchestrator`. The prerequisites via the plugin
are Node.js 24 LTS (with `npm ci` already run), `git`, `gh`, and the runner CLIs.

## Using it as a Codex plugin

The same repository can be added as a Codex plugin marketplace. Codex reads
`.codex-plugin/plugin.json` and `skills/`, and calls the same TypeScript CLI
(`node src/cli/main.ts`) as the Claude Code `commands/`.

```text
codex plugin marketplace add kkb-hub/hybrid-dev-orchestrator --ref main
codex plugin add hdo@hybrid-dev-orchestrator
```

After installing, start a new Codex session with the target repository as the working
directory. Ask in natural language, or name a skill explicitly:

| Skill | Purpose |
|---|---|
| `$hdo-doctor` | Preflight checks |
| `$hdo-config` | Resolved configuration and execution plan |
| `$hdo-issues` | List pickup candidates |
| `$hdo-inspect` | Inspect an issue and its normalized contract |
| `$hdo-run` | Execute a dry run or a full cycle |
| `$hdo-status` | Show run status |
| `$hdo-cleanup` | Remove a run worktree (preview by default) |
| `$hdo-labels` | Diff or synchronize the label catalog |

To validate a local checkout, pass the checkout path as the source of the first
command:

```text
codex plugin marketplace add C:\src\hybrid-dev-orchestrator
codex plugin add hdo@hybrid-dev-orchestrator
```

The prerequisites are the same through the plugin: Windows 11, Node.js 24 LTS (with
`npm ci` already run), `git`, `gh`, and the selected runner CLI. `$hdo-run` prefers
`-DryRun` unless you explicitly ask for a full run, and `$hdo-cleanup` always starts
with a preview.

## Updating the plugin version

Client repositories detect HDO updates **only** through the `version` in the plugin
manifests. When you change the distribution surface (`hdo.ps1`, `src/`, `commands/`,
`skills/`, `config/`, `schemas/`, `workers/`, or the runtime dependencies in
`package.json` / `package-lock.json`), raise the `version` in both
`.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` to the same value. Bumping
only one of them does not propagate the update correctly either. Changes limited to
`devDependencies` are exempt: they do not change what clients run.

`.github/workflows/plugin-version.yml` enforces this on pull requests and on pushes to
`main`, failing both missing bumps and version mismatches. To run the same check
locally:

```powershell
pwsh -NoProfile -File tools/check-plugin-version.ps1 -BaseRef origin/main
```

## CI

`.github/workflows/test-suite.yml` runs the full deterministic PowerShell test suite
(`pwsh -NoProfile -File ./tests/test-suite.ps1`) on `windows-latest` for pull requests
and pushes to `main`. A suite failure is a CI failure.

Checks that require an external provider — such as the real Ollama smoke test
(`tests/test-ollama-smoke.ps1 -Run`) — are deliberately kept out of normal CI and
remain explicitly opt-in. `.github/workflows/plugin-version.yml` handles only the
plugin version guard, keeping it separate from the main regression gate.

Per ADR-0001, official WSL2 and Linux support is handled on the TypeScript side and
will be considered in a separate issue once the TypeScript implementation reaches
Windows parity. There are no plans to add `ubuntu-latest` to the PowerShell suite's OS
matrix.

## Safety boundaries

- Implement and fix modify only a dedicated worktree, never your current working tree.
- Plan and review runners must be `read-only`, and implement and fix must be
  `workspace-write`, or configuration validation fails.
- GitHub tokens, and environment variables whose names match secret/token/password/API
  key patterns, are excluded from worker and validation processes by default.
- Validation gate working directories are confined to the worktree; junction and
  symbolic-link boundaries are rejected.
- stdout and stderr of external processes are truncated at 32 MiB each, and the
  process tree is terminated.
- Issues, comments, and external links are untrusted input.
- HDO never commits, pushes, opens PRs, closes issues, merges, or auto-applies
  results.
- Using a cloud runner or reviewer may transmit the issue, related code, and diffs to
  that cloud provider.

For the MVP command adapter and validation commands, HDO itself does not provide an OS
firewall, blocking of arbitrary filesystem access, or command interception. For
untrusted repositories, configure a low-privilege account, a VM or container, a runner
sandbox, and policy in the execution environment.

See [SECURITY.md](SECURITY.md) for the full threat model and for how to report a
vulnerability.

## The TypeScript implementation (migration in progress)

Following [ADR-0001](docs/adr/0001-primary-runtime-typescript.md), the project is
migrating in phases to TypeScript / Node.js 24 LTS as the medium-to-long-term primary
runtime. All nine `hdo` commands (`help`, `doctor`, `config`, `issues`, `inspect`,
`run`, `status`, `cleanup`, `labels`) are available in the TypeScript implementation
under `src/core/`, `src/platform/`, `src/process/`, `src/git/`, `src/github/`,
`src/runners/`, `src/workflow/`, and `src/cli/`.

```sh
npm ci
npm run typecheck
npm test
node src/cli/main.ts config -Json
node src/cli/main.ts doctor -DryRun -Json
node src/cli/main.ts issues -Json
node src/cli/main.ts inspect -Issue <n> -Json
node src/cli/main.ts run -Issue <n> -NoWriteBack -Json
node src/cli/main.ts status -RunId <id> -Json
node src/cli/main.ts cleanup -RunId <id> -WhatIf
node src/cli/main.ts labels -Apply -WhatIf
```

> **`npm ci` is mandatory if you use the plugins.** Since the phase 7 cut-over, all
> eight `commands/*.md` and all eight `skills/*/SKILL.md` invoke
> `node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" <command>` rather than `pwsh`
> (`hdo.ps1`). The TypeScript CLI needs its dependencies (`ajv`, `ajv-formats`,
> `koffi`) and `node_modules/` is gitignored, so **run `npm ci` once in the plugin
> root — this repository's root — before using an installed plugin.** Commands fail
> without `node_modules`.

- The PowerShell implementation has moved to **maintenance mode**: fixes to existing
  defects only, no new subsystems. `hdo.ps1` and `src/HybridDevOrchestrator/` have not
  been removed. `workers/hdo-ollama-worker.ps1` also moved to maintenance mode when
  phase 8 completed (2026-09-07), which means **`pwsh` is no longer required by any
  route of the TypeScript runtime** — it is needed only if you keep a custom config that
  explicitly launches the PowerShell worker. Phase 8 (c) — whether to adopt an AI SDK for
  the inner tool loop — was decided **against** on measured evidence, keeping the
  zero-dependency baseline ([ADR-0003](docs/adr/0003-agent-harness-lightweight.md)
  Amendment 2026-09-07; measurements in `poc/ai-sdk/results/`). See
  `docs/architecture.md` §16 for the detailed layout and dependency direction.
- Windows process-tree containment (`NodeProcessRunner`) holds a Win32 Job Object via
  `koffi` (FFI, pinned to an exact version in `package.json`). See
  [ADR-0002](docs/adr/0002-windows-job-object-via-koffi.md). `koffi` imports are
  confined to `src/platform/**` and cannot be imported from `src/core/**`;
  `src/core/boundary.test.ts` enforces this mechanically.
- `.github/workflows/typescript.yml` runs on **`windows-latest` only** — `npm ci` →
  typecheck → test → `help` smoke → `config -Json` → `doctor -DryRun -Json` (per
  ADR-0001 Amendment 2026-09-05, the migration's first target is Windows).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, how to run the test
suites, and the plugin version bump requirement. This project follows the
[Contributor Covenant](CODE_OF_CONDUCT.md).

## Further documentation

These documents are in Japanese.

- [Requirements](docs/requirements.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [GitHub Issue contract](docs/issue-contract.md)
- [Review platform](docs/review-platform.md)
- [Runtime evaluation: PowerShell vs TypeScript](docs/evaluation/powershell-vs-typescript.md)
- [Architecture proposal for adopting TypeScript](docs/evaluation/typescript-architecture-proposal.md)
- [ADRs](docs/adr/README.md)

## License

[MIT](LICENSE) © kkb-hub
