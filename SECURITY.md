# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities through GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/kkb-hub/hybrid-dev-orchestrator/security/advisories/new).

Please include the affected version (see `.claude-plugin/plugin.json`), your OS and
PowerShell/Node versions, a reproduction, and the impact you observed. Expect an
initial response within roughly two weeks. This is a personal project maintained on
a best-effort basis; there is no formal SLA and no bug bounty.

## Supported Versions

Only the latest release on `main` receives fixes. There are no maintained release
branches.

## Threat Model

HDO drives AI runners that execute commands on your machine. Understanding what it
does and does not protect against is essential before you point it at a repository.

### What HDO enforces

- `implement` and `fix` steps modify a **dedicated Git worktree only**, never your
  current working tree.
- `plan` and `review` runners must be `read-only`; `implement` and `fix` must be
  `workspace-write`. Configuration validation fails otherwise.
- GitHub tokens, and environment variables whose names match secret/token/password/
  API-key patterns, are **excluded from worker and validation processes by default**
  (see the deny list and redaction patterns in `src/HybridDevOrchestrator/Private/Common.ps1`
  and `src/core/process/redact.ts`).
- Validation gate working directories are confined to the worktree; junction and
  symbolic-link boundaries are rejected.
- stdout/stderr of external processes is truncated at 32 MiB per stream, and the
  process tree is terminated.
- HDO never commits, pushes, opens PRs, closes issues, merges, or auto-applies
  results. A human reviews the worktree.
- Validation commands are read **only** from the repository's committed
  `.hdo/project.json` — never from issue bodies.

### What HDO does *not* protect against

- HDO is **not a sandbox**. It does not provide an OS firewall, filesystem access
  control, or command interception for the MVP command adapter and validation
  commands.
- Issues, comments, and external links are **untrusted input** consumed by an LLM.
  Prompt injection that steers a runner is a real risk.
- Using a cloud runner or reviewer transmits the issue, related code, and diffs to
  that cloud provider.

For untrusted repositories, run HDO under a low-privilege account, in a VM or
container, with a runner sandbox and policy enforced by the execution environment.

## Scope

In scope: bypasses of the guarantees listed under *What HDO enforces* — for example,
escaping the worktree boundary, leaking a denied environment variable into a runner,
executing a command sourced from an issue body, or a `read-only` runner performing a
write.

Out of scope: the documented limitations under *What HDO does not protect against*,
and vulnerabilities in `git`, `gh`, `claude`, `codex`, or `ollama` themselves — report
those upstream.
