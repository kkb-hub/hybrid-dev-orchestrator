---
description: Run the HDO preflight (git, gh auth, project contract, runners, storage paths)
allowed-tools: Bash(node:*)
---

Run the Hybrid Dev Orchestrator preflight for the repository in the current working directory:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" doctor $ARGUMENTS
```

If the command fails with a missing-module error such as `Cannot find package 'ajv'`, tell the user to run `npm ci` once in the plugin root and retry; do not run the install yourself.

Pass any user-supplied arguments (for example `-Profile`, `-Config`, `-IgnoreRepositoryConfig`, `-DryRun`, `-Json`) through unchanged. HDO automatically reads committed `HEAD:.hdo/config.json`; explicit `-Config` may contain one path or a comma-separated ordered list. Exit code 3 means one or more required checks failed.

Afterwards, summarize each failing or warning check and suggest how to resolve it. Do not attempt to fix anything without asking first.
