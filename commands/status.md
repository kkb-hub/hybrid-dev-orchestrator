---
description: Show the stored state of an HDO run
argument-hint: <run-id>
allowed-tools: Bash(pwsh:*)
---

Show the stored state of a Hybrid Dev Orchestrator run. The run ID is required; if the user did not provide one, ask for it.

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" status -RepositoryPath "<absolute path of the current working directory>" -RunId <run-id> -Json $ARGUMENTS
```

Afterwards, summarize the state, current iteration, the latest review decision and open findings, validation gate results, and the artifact and worktree paths.
