---
description: List GitHub Issues eligible for HDO pickup
allowed-tools: Bash(node:*)
---

List the GitHub Issues that are eligible for Hybrid Dev Orchestrator pickup:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" issues -Json $ARGUMENTS
```

If the command fails with a missing-module error such as `Cannot find package 'ajv'`, tell the user to run `npm ci` once in the plugin root and retry; do not run the install yourself.

Pass any user-supplied arguments (for example `-Repository owner/repo`) through unchanged. Exit code 4 means no eligible Issue was found.

Afterwards, present the candidates as a short table ordered as returned (priority, then creation time, then Issue number) with number, priority, title, and URL.
