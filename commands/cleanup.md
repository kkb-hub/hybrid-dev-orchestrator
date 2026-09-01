---
description: Remove the worktree of a finished HDO run
argument-hint: <run-id> [-Force]
allowed-tools: Bash(pwsh:*)
---

Remove the dedicated worktree of a Hybrid Dev Orchestrator run. The run ID is required; if the user did not provide one, ask for it.

HDO worktrees intentionally hold uncommitted changes, so cleanup of a dirty worktree is refused without `-Force`. Always start with a preview:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" cleanup -RunId <run-id> -WhatIf $ARGUMENTS
```

Only add `-Force` (without `-WhatIf`) after the user has confirmed that the run's `final/diff.patch` and any new files they want to keep are saved elsewhere. Never add `-Force` on your own initiative. Run artifacts and the created branch remain after cleanup.
