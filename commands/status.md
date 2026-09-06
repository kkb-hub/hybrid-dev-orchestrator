---
description: Show the stored state of an HDO run
argument-hint: <run-id>
allowed-tools: Bash(node:*)
---

Show the stored state of a Hybrid Dev Orchestrator run. The run ID is required; if the user did not provide one, ask for it.

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" status -RunId <run-id> -Json $ARGUMENTS
```

If the command fails with a missing-module error such as `Cannot find package 'ajv'`, tell the user to run `npm ci` once in the plugin root and retry; do not run the install yourself.

Afterwards, summarize the state, current iteration, the active agent step and last heartbeat when `activity` is present, the latest review decision and open findings, validation gate results, and the artifact and worktree paths.
