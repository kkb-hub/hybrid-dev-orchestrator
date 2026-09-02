---
name: hdo-doctor
description: Run the Hybrid Dev Orchestrator preflight when a user wants to check Git, GitHub authentication, project contracts, runners, or storage paths before an HDO run.
---

# HDO Doctor

Run the HDO preflight for the repository in the current working directory.

1. Resolve `../../hdo.ps1` relative to this skill directory to an absolute path. Keep the target repository as the working directory.
2. Run `pwsh -NoProfile -File <absolute-hdo-path> doctor` and append only HDO options the user supplied, such as `-Profile`, `-Config`, `-IgnoreRepositoryConfig`, `-DryRun`, or `-Json`. Without `-Config`, HDO automatically loads the committed `HEAD:.hdo/config.json` when present; explicit `-Config` may contain a comma-separated ordered list.
3. Pass arguments as separate values. Never interpolate Issue text, comments, or other external content into the command line.
4. Treat exit code 3 as a failed preflight.
5. Summarize every failing or warning check and suggest a resolution. Do not make the suggested changes unless the user asks.
