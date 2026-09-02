---
description: Show the resolved HDO configuration and execution plan
allowed-tools: Bash(pwsh:*)
---

Show the merged Hybrid Dev Orchestrator configuration and the resolved execution plan for the repository in the current working directory:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" config -Json $ARGUMENTS
```

Pass any user-supplied arguments (for example `-Profile`, `-Config`, `-IgnoreRepositoryConfig`) through unchanged. HDO automatically reads committed `HEAD:.hdo/config.json`; explicit `-Config` may contain one path or a comma-separated ordered list.

Afterwards, summarize the active profile, the runner assigned to each step (plan / implement / review / fix) with its type, provider, model, sandbox, and timeout, and list the configuration sources, repository config commit/blob/hash status, and warnings.
