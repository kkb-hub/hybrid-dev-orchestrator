---
name: hdo-issues
description: List GitHub Issues eligible for Hybrid Dev Orchestrator pickup when a user wants to find or prioritize HDO-ready work.
---

# HDO Issues

List the GitHub Issues eligible for HDO pickup.

1. Resolve `../../src/cli/main.ts` relative to this skill directory to an absolute path. Keep the target repository as the working directory. If the command fails because `node_modules` is missing, run `npm ci` once in the plugin root, then retry.
2. Run `node <absolute-path> issues -Json` and append only HDO options the user supplied, such as `-Repository owner/repo`.
3. Pass arguments as separate values. Never interpolate Issue text, comments, or other external content into the command line.
4. Treat exit code 4 as no eligible Issue rather than a command failure.
5. Present candidates in the returned order as a short table with number, priority, title, and URL.
