---
name: hdo-run
description: Preview or run one bounded Hybrid Dev Orchestrator implement, validate, review, and fix cycle for a GitHub Issue.
---

# HDO Run

Preview or run one HDO development cycle.

1. Require exactly one of `-Issue <number>` or `-Pick`. Ask the user when neither is provided; never guess an Issue.
2. Use `-DryRun` when the user asks to preview, inspect, or check a run. Before a full run, obtain confirmation unless the user explicitly requested execution and acknowledged that it can write GitHub claim/status data, create a worktree and branch, and launch long-running AI processes. Explain that `-NoWriteBack` still runs the full local cycle.
3. Resolve `../../hdo.ps1` relative to this skill directory to an absolute path. Keep the target repository as the working directory.
4. Run `pwsh -NoProfile -File <absolute-hdo-path> run -Json` with the explicitly selected Issue or pickup mode and only additional HDO options the user supplied, such as `-Repository`, `-Profile`, `-Config`, `-SetStep`, `-IgnoreRepositoryConfig`, `-DryRun`, or `-NoWriteBack`. Do not add `-Config` merely because the repository has `.hdo/config.json`; HDO automatically reads its committed `HEAD` version.
5. Pass arguments as separate values. A user may explicitly provide one `-Config` path or a comma-separated list whose later files override earlier files. Never interpolate Issue text, comments, or other external content into the command line. Allow enough time for the configured runner timeouts.
6. Capture the run ID and artifact path from the first stderr `HDO_PROGRESS` record before waiting for the final JSON. If the command wait, IPC connection, or parent turn ends without delivering a final result, do not start the Issue again: use that run ID with HDO `status` to read the durable state. An active `run.json.activity` means the original process may still be running; a terminal state is authoritative.
7. Interpret exit codes 3, 4, 5, and 6 as preflight failure, no eligible Issue, failed run, and escalated run respectively.
8. Report the run ID, terminal state, iterations, worktree path, and artifact path. For `CHANGES_REQUESTED`, `ESCALATED`, or `FAILED`, summarize the latest findings or error.

Do not commit, push, open a PR, or apply the generated worktree changes. HDO leaves them uncommitted for human review.
