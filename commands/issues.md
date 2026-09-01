---
description: List GitHub Issues eligible for HDO pickup
allowed-tools: Bash(pwsh:*)
---

List the GitHub Issues that are eligible for Hybrid Dev Orchestrator pickup:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" issues -RepositoryPath "<absolute path of the current working directory>" -Json $ARGUMENTS
```

Pass any user-supplied arguments (for example `-Repository owner/repo`) through unchanged. Exit code 4 means no eligible Issue was found.

Afterwards, present the candidates as a short table ordered as returned (priority, then creation time, then Issue number) with number, priority, title, and URL.
