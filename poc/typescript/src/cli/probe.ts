// `probe` prints JSON describing OS differences actually observed at runtime. This is
// the raw material for README's "観測した OS 差分" table; run on Windows and inside the
// Ubuntu container, then diff results/windows.json against results/ubuntu.json.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { EOL, homedir, release, tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import type { PlatformAdapter } from "../platform/types.ts";

/**
 * F-05: measures exactly which environment variables Node/libuv injects into a child
 * that is spawned with an *explicit* `env` (i.e. NOT inherited from this process).
 * `process/runner.ts`'s old `WINDOWS_PASSTHROUGH_VARS` was dead code attempting to
 * paper over this by re-adding SYSTEMROOT/PATH itself; it turns out libuv already
 * does its own injection unconditionally on Windows regardless of what the caller
 * passes, so that passthrough never had any observable effect and has been removed.
 * On POSIX, an explicit `env` is exactly what the child sees (this should report `[]`
 * there).
 */
function detectExplicitEnvExtraKeys(): string[] {
  const marker = "HDO_PROBE_EXPLICIT_ENV_MARKER";
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
    { env: { [marker]: "1" }, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const keys = JSON.parse(result.stdout) as string[];
    return keys.filter((key) => key !== marker).sort();
  } catch {
    return [];
  }
}

function detectCaseSensitiveTempFs(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "hdo-poc-case-"));
  try {
    writeFileSync(join(dir, "A.tmp"), "x");
    try {
      statSync(join(dir, "a.tmp"));
      return false; // lowercase resolved the uppercase file -> case-insensitive filesystem
    } catch {
      return true;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function detectSymlinkCreation(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "hdo-poc-symlink-"));
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "x");
    try {
      symlinkSync(target, join(dir, "link.txt"), "file");
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runProbe(platform: PlatformAdapter, json: boolean): Promise<number> {
  const gitExecutableName = process.platform === "win32" ? "git.exe" : "git";
  const nodeExecutableName = process.platform === "win32" ? "node.exe" : "node";

  const report = {
    schemaVersion: 1,
    platform: process.platform,
    release: release(),
    nodeVersion: process.version,
    pathSep: sep,
    pathDelimiter: delimiter,
    caseSensitiveTempFs: detectCaseSensitiveTempFs(),
    executableResolution: {
      git: platform.resolveExecutable(gitExecutableName) ?? null,
      node: platform.resolveExecutable(nodeExecutableName) ?? null,
      nonexistent: platform.resolveExecutable("hdo-poc-definitely-not-a-real-command") ?? null,
    },
    userConfigDir: platform.userConfigDir(),
    defaultDataDir: platform.defaultDataDir(),
    processGroupKillSupported: process.platform !== "win32",
    processTreeKillStrategy: platform.processTreeKillStrategy(),
    osEolEscaped: JSON.stringify(EOL),
    symlinkCreationSucceeded: detectSymlinkCreation(),
    pathext: process.env.PATHEXT ?? null,
    homedir: homedir(),
    tmpdir: tmpdir(),
    envVarCount: Object.keys(process.env).length,
    // Windows env vars are case-insensitive; Node does not normalize casing itself, so
    // `process.env.PATH` and `process.env.Path` alias the same variable there but are
    // two distinct keys on POSIX (where only one of them is normally set). Report only
    // the comparison (not the raw PATH value, which is machine-specific and noisy to
    // commit as a results/*.json artifact).
    envPathUpperKeyDefined: process.env.PATH !== undefined,
    envPathMixedKeyDefined: (process.env as Record<string, string | undefined>).Path !== undefined,
    envPathUpperAndMixedKeysAlias: process.env.PATH === (process.env as Record<string, string | undefined>).Path,
    explicitEnvExtraKeys: detectExplicitEnvExtraKeys(),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const [key, value] of Object.entries(report)) {
      process.stdout.write(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
    }
  }
  return 0;
}
