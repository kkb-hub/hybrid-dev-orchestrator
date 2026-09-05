// Windows-only: verifies `createWindowsPlatformAdapter().expandPath` expands an 8.3
// short name (`PROGRA~1`) found in the resolved path's EXISTING prefix the same way
// .NET `[System.IO.Path]::GetFullPath` does (`GetLongPathNameW`), and does nothing at
// all when the path contains no `~` (matching .NET's own fast path). See
// docs/architecture.md 16.4 item 9 and src/platform/windows.ts's
// `expandShortNamesInExistingPrefix` for the full writeup, including the documented
// approximation (`fs.realpathSync.native` also resolves reparse points, which
// `GetLongPathNameW` does not).
//
// Skipped entirely off Windows, and skipped if this machine has no `C:\PROGRA~1`
// short name to exercise (every ordinary Windows install does, but this guards
// against an unusual environment rather than failing loudly).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createWindowsPlatformAdapter } from "./windows.ts";

const IS_WINDOWS = process.platform === "win32";
const PROGRA_SHORT_NAME = "C:\\PROGRA~1";
const HAS_PROGRA_SHORT_NAME = IS_WINDOWS && existsSync(PROGRA_SHORT_NAME);
const SKIP_REASON = !IS_WINDOWS
  ? "windows-only"
  : !HAS_PROGRA_SHORT_NAME
    ? "C:\\PROGRA~1 does not exist on this machine"
    : false;

/** The oracle: spawns `pwsh` to compute the real `[IO.Path]::GetFullPath` result, when pwsh is available. */
function dotnetGetFullPath(input: string): string | undefined {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", `[IO.Path]::GetFullPath('${input}')`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return undefined;
  return probe.stdout.trim();
}

test("expandPath expands an 8.3 short name in the existing prefix like .NET GetFullPath", { skip: SKIP_REASON }, () => {
  const adapter = createWindowsPlatformAdapter();
  const input = "C:\\PROGRA~1\\hdo-does-not-exist\\x.json";
  // Hardcoded fallback matches this repo's verified `[IO.Path]::GetFullPath` output
  // for every ordinary Windows install (C:\PROGRA~1 always expands to
  // "C:\Program Files"); used only when pwsh itself is not on PATH.
  const expected = dotnetGetFullPath(input) ?? "C:\\Program Files\\hdo-does-not-exist\\x.json";
  const result = adapter.expandPath(input, undefined);
  assert.equal(result, expected);
});

test("expandPath leaves a path without '~' unchanged by the short-name post-step", { skip: SKIP_REASON }, () => {
  const adapter = createWindowsPlatformAdapter();
  const input = "C:\\Windows\\System32\\hdo-does-not-exist\\x.json";
  const result = adapter.expandPath(input, undefined);
  assert.equal(result, input);
});
