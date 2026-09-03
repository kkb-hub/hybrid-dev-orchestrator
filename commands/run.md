---
description: Run one HDO implement/validate/review/fix cycle for a GitHub Issue
argument-hint: -Issue <number> | -Pick [-DryRun] [-NoWriteBack]
allowed-tools: Bash(pwsh:*)
---

Run one Hybrid Dev Orchestrator cycle. Either `-Issue <number>` or `-Pick` is required; if the user provided neither, ask which Issue to run instead of guessing.

Before a full run, confirm intent with the user unless they explicitly asked for it: a full run claims the Issue on GitHub (unless `-NoWriteBack`), creates a dedicated worktree and branch, and launches AI runner processes that can take a long time. Suggest `-DryRun` first when the user seems unsure.

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" run -Json $ARGUMENTS
```

Pass all user-supplied arguments through unchanged (for example `-Issue`, `-Pick`, `-Repository`, `-Profile`, `-Config`, `-SetStep`, `-IgnoreRepositoryConfig`, `-DryRun`, `-NoWriteBack`). Do not add `-Config` just because `.hdo/config.json` exists: HDO automatically reads the committed `HEAD` version. An explicit `-Config` may contain one path or a comma-separated ordered list. Use a generous Bash timeout: a full cycle can run for the configured runner timeouts (up to hours). Exit codes: 3 preflight failed, 4 no eligible Issue, 5 FAILED, 6 ESCALATED.

Capture the run ID and artifact path from the first stderr `HDO_PROGRESS` record. If the command wait, IPC connection, or parent turn ends before the final JSON is delivered, do not start the Issue again. Run `status -RunId <captured-id> -Json`; an active `run.json.activity` means the original process may still be running, while a terminal stored state is authoritative.

Afterwards, report the run ID, terminal state, iterations, worktree path, and artifact path. If the run ended in CHANGES_REQUESTED/ESCALATED/FAILED, summarize the last review findings or error. Do not commit, push, or apply the worktree changes anywhere; HDO intentionally leaves them uncommitted for human review.
