---
description: Run the HDO preflight (git, gh auth, project contract, runners, storage paths)
allowed-tools: Bash(pwsh:*)
---

Run the Hybrid Dev Orchestrator preflight for the repository in the current working directory:

```
pwsh -NoProfile -File "${CLAUDE_PLUGIN_ROOT}/hdo.ps1" doctor -RepositoryPath "<absolute path of the current working directory>" $ARGUMENTS
```

Pass any user-supplied arguments (for example `-Profile`, `-Config`, `-DryRun`, `-Json`) through unchanged. Exit code 3 means one or more required checks failed.

Afterwards, summarize each failing or warning check and suggest how to resolve it. Do not attempt to fix anything without asking first.
