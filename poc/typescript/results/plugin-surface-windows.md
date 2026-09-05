# Plugin-surface invocation verification (Windows, AC-05)

Verifies that a Claude Code command body (`${CLAUDE_PLUGIN_ROOT}/poc/typescript/...`)
and the `bin/hdo-poc(.cmd)` launcher wrappers can invoke the TypeScript PoC CLI
without a build step, and that the launcher wrappers are independent of the caller's
current working directory. Run on Windows 11 (Git Bash), Node v24.19.0, from the
repository at `C:\Users\redacted\source\github\kkb-hub\hybrid-dev-orchestrator`.

## 1. Command-body invocation style (mirrors `commands/doctor.md`)

Command run from the repository root, exactly as `hdo-poc-doctor.md`'s body would be
expanded by Claude Code (`${CLAUDE_PLUGIN_ROOT}` set to the repository root):

```sh
cd "C:\Users\redacted\source\github\kkb-hub\hybrid-dev-orchestrator"
export CLAUDE_PLUGIN_ROOT="$PWD"
node "$CLAUDE_PLUGIN_ROOT/poc/typescript/src/cli/main.ts" doctor --json
```

Output:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "checks": [
    {
      "name": "node-version",
      "status": "pass",
      "detail": "node 24.19.0 (requires >= 22.18 for native type stripping)"
    },
    {
      "name": "git",
      "status": "pass",
      "detail": "resolved: C:\\Program Files\\Git\\mingw64\\bin\\git.exe"
    },
    {
      "name": "config",
      "status": "pass",
      "detail": "loaded and validated from 1 source(s): C:\\Users\\redacted\\source\\github\\kkb-hub\\hybrid-dev-orchestrator\\config\\hdo.default.json"
    }
  ]
}
```

Result: **pass**, exit code 0. `node` ran the `.ts` file directly with no build step.

## 2. `bin/hdo-poc.cmd` launcher, invoked from an unrelated working directory

```sh
mkdir -p /tmp/hdo-poc-cwd-test && cd /tmp/hdo-poc-cwd-test
pwd
"C:\Users\redacted\source\github\kkb-hub\hybrid-dev-orchestrator\poc\typescript\plugin-surface\bin\hdo-poc.cmd" doctor --json
```

Output:

```
/tmp/hdo-poc-cwd-test
{
  "schemaVersion": 1,
  "ok": true,
  "checks": [
    { "name": "node-version", "status": "pass", "detail": "node 24.19.0 (requires >= 22.18 for native type stripping)" },
    { "name": "git", "status": "pass", "detail": "resolved: C:\\Program Files\\Git\\mingw64\\bin\\git.exe" },
    { "name": "config", "status": "pass", "detail": "loaded and validated from 1 source(s): C:\\Users\\redacted\\source\\github\\kkb-hub\\hybrid-dev-orchestrator\\config\\hdo.default.json" }
  ]
}
```

Result: **pass**, exit code 0, run from `/tmp/hdo-poc-cwd-test` (unrelated to the repo)
proving the wrapper resolves its own directory (`%~dp0..\..\src\cli\main.ts`) rather
than depending on the caller's cwd.

**Bug found and fixed during this verification:** the first draft of both
`bin/hdo-poc` and `bin/hdo-poc.cmd` pointed at `<bindir>/../src/cli/main.ts` (one
`..`), which resolves to `plugin-surface/src/cli/main.ts` - one level too shallow,
since `bin/` sits under `plugin-surface/`, not directly under `poc/typescript/`. This
failed with `MODULE_NOT_FOUND` when actually exercised. Fixed to `../../src/cli/main.ts`
(two levels up) in both wrappers. This is exactly the kind of mistake that only an
actual run (not just reading the script) catches.

## 3. POSIX `bin/hdo-poc` launcher, invoked from an unrelated working directory

```sh
cd /tmp/hdo-poc-cwd-test
sh "C:\Users\redacted\source\github\kkb-hub\hybrid-dev-orchestrator\poc\typescript\plugin-surface\bin\hdo-poc" probe --json
```

Output (truncated to the first fields; full report has all `probe` fields):

```json
{
  "schemaVersion": 1,
  "platform": "win32",
  "release": "10.0.26200",
  "nodeVersion": "v24.19.0",
  "pathSep": "\\",
  "pathDelimiter": ";",
  "...": "..."
}
```

Result: **pass**, exit code 0, run from `/tmp/hdo-poc-cwd-test` under Git Bash's `sh`.

## Summary

| Invocation path | cwd at call time | Exit code | Result |
|---|---|---|---|
| `node "$CLAUDE_PLUGIN_ROOT/poc/typescript/src/cli/main.ts" doctor --json` | repo root | 0 | pass |
| `plugin-surface/bin/hdo-poc.cmd doctor --json` | `/tmp/hdo-poc-cwd-test` | 0 | pass |
| `plugin-surface/bin/hdo-poc probe --json` (via `sh`) | `/tmp/hdo-poc-cwd-test` | 0 | pass |

All three invocation styles ran the `.ts` CLI with no build step and no dependency on
the caller's current working directory.
