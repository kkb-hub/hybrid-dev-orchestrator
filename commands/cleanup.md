---
description: Remove the worktree of a finished HDO run
argument-hint: <run-id> [-Force]
allowed-tools: Bash(node:*)
---

Remove the dedicated worktree of a Hybrid Dev Orchestrator run. The run ID is required; if the user did not provide one, ask for it.

HDO worktrees intentionally hold uncommitted changes, so cleanup of a dirty worktree is refused without `-Force`. Always start with a preview:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" cleanup -RunId <run-id> -WhatIf $ARGUMENTS
```

If the command fails with a missing-module error such as `Cannot find package 'ajv'`, tell the user to run `npm ci` once in the plugin root and retry; do not run the install yourself.

Only add `-Force` (without `-WhatIf`) after the user has confirmed that the run's `final/diff.patch` and any new files they want to keep are saved elsewhere. Never add `-Force` on your own initiative. Run artifacts and the created branch remain after cleanup.
