---
description: Run one HDO implement/validate/review/fix cycle for a GitHub Issue
argument-hint: -Issue <number> | -Pick [-DryRun] [-NoWriteBack]
allowed-tools: Bash(pwsh:*)
---

Run one Hybrid Dev Orchestrator cycle. Either `-Issue <number>` or `-Pick` is required; if the user provided neither, ask which Issue to run instead of guessing.

Before a full run, confirm intent with the user unless they explicitly asked for it: a full run claims the Issue on GitHub (unless `-NoWriteBack`), creates a dedicated worktree and branch, and launches AI runner processes that can take a long time. Suggest `-DryRun` first when the user seems unsure.

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" run -RepositoryPath "<absolute path of the current working directory>" -Json $ARGUMENTS
```

Pass all user-supplied arguments through unchanged (for example `-Issue`, `-Pick`, `-Repository`, `-Profile`, `-Config`, `-SetStep`, `-DryRun`, `-NoWriteBack`). Use a generous Bash timeout: a full cycle can run for the configured runner timeouts (up to hours). Exit codes: 3 preflight failed, 4 no eligible Issue, 5 FAILED, 6 ESCALATED.

Afterwards, report the run ID, terminal state, iterations, worktree path, and artifact path. If the run ended in CHANGES_REQUESTED/ESCALATED/FAILED, summarize the last review findings or error. Do not commit, push, or apply the worktree changes anywhere; HDO intentionally leaves them uncommitted for human review.
