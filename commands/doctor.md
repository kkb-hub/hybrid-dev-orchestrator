---
description: Run the HDO preflight (git, gh auth, project contract, runners, storage paths)
allowed-tools: Bash(pwsh:*)
---

Run the Hybrid Dev Orchestrator preflight for the repository in the current working directory:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" doctor $ARGUMENTS
```

Pass any user-supplied arguments (for example `-Profile`, `-Config`, `-IgnoreRepositoryConfig`, `-DryRun`, `-Json`) through unchanged. HDO automatically reads committed `HEAD:.hdo/config.json`; explicit `-Config` may contain one path or a comma-separated ordered list. Exit code 3 means one or more required checks failed.

Afterwards, summarize each failing or warning check and suggest how to resolve it. Do not attempt to fix anything without asking first.
