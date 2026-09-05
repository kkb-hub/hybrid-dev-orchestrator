---
description: (PoC, Issue #18) Run the TypeScript/Node.js HDO doctor preflight instead of the PowerShell hdo.ps1 doctor
allowed-tools: Bash(node:*)
---

Run the TypeScript/Node.js proof-of-concept's preflight for the repository in the current working directory:

```
node "${CLAUDE_PLUGIN_ROOT}/poc/typescript/src/cli/main.ts" doctor --json
```

This is a runtime-evaluation artifact for Issue #18 (AC-05) and is NOT registered in
`.claude-plugin/plugin.json`; it exists only to prove that a Claude Code command body
can invoke `node` against a `.ts` file through `${CLAUDE_PLUGIN_ROOT}` the same way
`commands/doctor.md` invokes `pwsh -File hdo.ps1`, with no build step in between.

Exit code 3 means one or more required checks (Node version, git availability, config
load/validate) failed. Summarize each failing check and suggest how to resolve it. Do
not attempt to fix anything without asking first.
