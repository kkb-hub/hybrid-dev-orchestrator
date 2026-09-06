---
description: Preview or synchronize the HDO label catalog on GitHub
argument-hint: [-Apply]
allowed-tools: Bash(node:*)
---

Preview or synchronize the Hybrid Dev Orchestrator label catalog (`hdo:ready`, `hdo:status/*`, priority/risk/route labels) on the GitHub repository.

Without `-Apply` this is a read-only diff preview:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/main.ts" labels $ARGUMENTS
```

If the command fails with a missing-module error such as `Cannot find package 'ajv'`, tell the user to run `npm ci` once in the plugin root and retry; do not run the install yourself.

Pass user-supplied arguments (for example `-Repository owner/repo`, `-Apply`, `-WhatIf`) through unchanged. Only include `-Apply` when the user explicitly asked to apply the changes; otherwise show the preview and ask.

Afterwards, summarize which labels would be created, updated, or left unchanged. Labels outside the `hdo:` namespace are never modified.
