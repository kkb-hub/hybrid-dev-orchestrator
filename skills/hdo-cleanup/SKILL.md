---
name: hdo-cleanup
description: Preview or remove the dedicated worktree of a finished Hybrid Dev Orchestrator run, with safeguards for uncommitted changes.
---

# HDO Cleanup

Preview cleanup before removing an HDO run worktree.

1. Require a run ID. Ask the user when it is missing; never guess one.
2. Resolve `../../hdo.ps1` relative to this skill directory to an absolute path. Keep the target repository as the working directory.
3. First run `pwsh -NoProfile -File <absolute-hdo-path> cleanup -RunId <run-id> -WhatIf` with any additional HDO options the user supplied.
4. Pass arguments as separate values. Never interpolate artifact contents into the command line.
5. Explain what would be removed. HDO worktrees can contain intentional uncommitted changes, so do not remove one unless the user explicitly confirms the exact run after reviewing the preview.
6. Add `-Force` and omit `-WhatIf` only after the user confirms that `final/diff.patch` and any new files they want are saved elsewhere. Never infer permission to force cleanup.

Run artifacts and the created branch remain after cleanup.
