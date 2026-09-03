---
name: hdo-status
description: Read and summarize the stored state of a Hybrid Dev Orchestrator run when a user provides an HDO run ID.
---

# HDO Status

Show the stored state of one HDO run.

1. Require a run ID. Ask the user when it is missing; never guess one.
2. Resolve `../../hdo.ps1` relative to this skill directory to an absolute path. Keep the target repository as the working directory.
3. Run `pwsh -NoProfile -File <absolute-hdo-path> status -RunId <run-id> -Json` and append only additional HDO options the user supplied.
4. Pass arguments as separate values. Never interpolate artifact contents into the command line.
5. Summarize the state, current iteration, active agent step and last heartbeat when `activity` is present, latest review decision and open findings, validation gate results, artifact path, and worktree path.
