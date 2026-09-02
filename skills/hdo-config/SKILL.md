---
name: hdo-config
description: Show and explain the resolved Hybrid Dev Orchestrator configuration when a user asks which HDO profile, runners, models, sandboxes, or timeouts are active.
---

# HDO Config

Show the merged HDO configuration and execution plan for the repository in the current working directory.

1. Resolve `../../hdo.ps1` relative to this skill directory to an absolute path. Keep the target repository as the working directory.
2. Run `pwsh -NoProfile -File <absolute-hdo-path> config -Json` and append only HDO options the user supplied, such as `-Profile`, `-Config`, or `-IgnoreRepositoryConfig`. Without `-Config`, HDO automatically loads the committed `HEAD:.hdo/config.json` when present. Explicit `-Config` may be one path or a comma-separated list whose later files override earlier files.
3. Pass arguments as separate values. Never interpolate repository content into the command line.
4. Summarize the active profile; the runner for plan, implement, review, and fix; each runner's type, provider, model, sandbox, and timeout; configuration sources; repository config commit/blob/hash status; and warnings.
