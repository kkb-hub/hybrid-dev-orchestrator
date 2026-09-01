---
description: Show the resolved HDO configuration and execution plan
allowed-tools: Bash(pwsh:*)
---

Show the merged Hybrid Dev Orchestrator configuration and the resolved execution plan for the repository in the current working directory:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" config -RepositoryPath "<absolute path of the current working directory>" -Json $ARGUMENTS
```

Pass any user-supplied arguments (for example `-Profile`, `-Config`) through unchanged.

Afterwards, summarize the active profile, the runner assigned to each step (plan / implement / review / fix) with its type, model, sandbox, and timeout, and list the configuration sources and warnings.
