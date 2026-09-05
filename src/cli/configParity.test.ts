// AC-05: compares `node src/cli/main.ts config -Json` against `pwsh -NoProfile -File
// hdo.ps1 config -Json` (the oracle) for the default config and every applicable
// config/examples/*.json passed via -Config. Both processes run with the SAME
// environment, with APPDATA/LOCALAPPDATA redirected to a fresh temp directory so no
// real user config on this machine can leak into either run, and the same
// -RepositoryPath (this repository root, so both resolve the same git repository
// and the same committed .hdo/config.json state).
//
// Skipped entirely (node:test `skip`) when `pwsh` is not on PATH.
//
// Not exercised here: "-Profile variants where the example defines multiple
// profiles" - none of the current config/examples/*.json files define more than one
// profile (each has exactly one profile matching its own activeProfile), so this
// dimension has nothing to vary today. config/examples/repository-ollama-hybrid.json
// is a repository config (schemas/hdo-repository-config.schema.json), not an
// hdo-config document, and is intentionally excluded from the -Config cases (passing
// it would fail hdo-config schema validation in both implementations identically,
// which is not an interesting parity case).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MAIN_TS_PATH = resolve(HERE, "main.ts");
const HDO_PS1_PATH = resolve(REPO_ROOT, "hdo.ps1");

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync(process.execPath, [MAIN_TS_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd: REPO_ROOT,
    windowsHide: true,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runPwsh(args: string[], env: NodeJS.ProcessEnv): ProcessResult {
  const result = spawnSync("pwsh", ["-NoProfile", "-File", HDO_PS1_PATH, ...args], {
    encoding: "utf8",
    env,
    cwd: REPO_ROOT,
    windowsHide: true,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

/** Absolute-path-looking string: a drive letter + `:/` after separator normalization. */
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

function normalizeStringValue(value: string): string {
  const withForwardSlashes = value.replace(/\\/g, "/");
  if (process.platform === "win32" && WINDOWS_ABSOLUTE_PATH_PATTERN.test(withForwardSlashes)) {
    return withForwardSlashes.toLowerCase();
  }
  return withForwardSlashes;
}

/** Recursively sorts object keys and normalizes string values, for an order- and separator-independent comparison. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "string") return normalizeStringValue(value);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function deleteGeneratedAt(value: unknown): void {
  if (value && typeof value === "object" && "execution" in value) {
    const execution = (value as Record<string, unknown>).execution;
    if (execution && typeof execution === "object") {
      delete (execution as Record<string, unknown>).generatedAt;
    }
  }
}

interface ParityCase {
  name: string;
  args: string[];
}

const CASES: ParityCase[] = [
  { name: "default config (no -Config)", args: [] },
  { name: "-Config config/examples/cloud-only.json", args: ["-Config", "config/examples/cloud-only.json"] },
  { name: "-Config config/examples/ollama-hybrid.json", args: ["-Config", "config/examples/ollama-hybrid.json"] },
  {
    name: "-Config config/examples/claude-only.json (partial overlay onto hdo.default.json)",
    args: ["-Config", "config/examples/claude-only.json"],
  },
  { name: "-Config config/examples/ollama-lean-worker.json", args: ["-Config", "config/examples/ollama-lean-worker.json"] },
  { name: "-IgnoreRepositoryConfig", args: ["-IgnoreRepositoryConfig"] },
];

// PowerShell's console host renders `Write-Error` with ANSI color escapes and (on the
// first emitted line only) a literal "Write-Error: " label; hdo.ps1's own top-level
// catch (see hdo.ps1:153-156) never adds a "hdo.ps1: " prefix itself, but the strip is
// included defensively in case that ever changes. Stripping both, then comparing a
// fixed number of leading lines, is the only fair way to compare PS/TS error text: the
// underlying message content is expected to be identical even though the two hosts
// format/wrap it differently.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function stripPsStderrDecoration(stderr: string): string {
  return stderr.replace(ANSI_ESCAPE_PATTERN, "").replace(/^(Write-Error: |hdo\.ps1: )/, "");
}

function firstLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .slice(0, count)
    .join("\n");
}

interface NegativeParityCase {
  name: string;
  /** Builds the `-Config`/`-Profile`/etc. args for this case; `overlayPath` is a writable temp file path (unused unless `overlay` is set). */
  buildArgs: (overlayPath: string) => string[];
  /** JSON written to `overlayPath` before running, if this case needs a `-Config` overlay. */
  overlay?: unknown;
  /** How many leading (newline-split) lines of the decoration-stripped stderr must match exactly. */
  compareLines: number;
  /**
   * When set, only assert that BOTH stderrs start with this literal prefix (rather
   * than asserting the compared lines are byte-identical) - used where Ajv and
   * PowerShell's Test-Json produce different error tails for the same schema
   * violation (see resolve.ts's documented divergence).
   */
  expectedPrefix?: string;
}

const NEGATIVE_CASES: NegativeParityCase[] = [
  {
    name: "-Config pointing to a missing file",
    buildArgs: () => ["-Config", resolve(tmpdir(), "hdo-config-parity-missing-does-not-exist.json")],
    compareLines: 1,
  },
  {
    name: "-Profile nope",
    buildArgs: () => ["-Profile", "nope"],
    compareLines: 1,
  },
  {
    name: "overlay workflow.maxFixAttempts=11 (schema validation failure)",
    buildArgs: (overlayPath) => ["-Config", overlayPath],
    overlay: { workflow: { maxFixAttempts: 11 } },
    // Only the "Configuration schema validation failed: " prefix is guaranteed to
    // match (Ajv vs Test-Json produce different error tails) - see resolve.ts.
    compareLines: 1,
    expectedPrefix: "Configuration schema validation failed: ",
  },
  {
    name: "overlay routing the plan step to a workspace-write runner",
    buildArgs: (overlayPath) => ["-Config", overlayPath],
    overlay: { profiles: { "claude-only": { steps: { plan: "claude-implementer" } } } },
    compareLines: 2,
  },
  {
    name: "overlay github.labels.ready='HDO:Priority/x'",
    buildArgs: (overlayPath) => ["-Config", overlayPath],
    overlay: { github: { labels: { ready: "HDO:Priority/x" } } },
    compareLines: 2,
  },
];

for (const negativeCase of NEGATIVE_CASES) {
  test(`config parity (negative): ${negativeCase.name}`, { skip: SKIP_REASON }, () => {
    const tempHome = mkdtempSync(join(tmpdir(), "hdo-config-parity-neg-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: join(tempHome, "AppData", "Local"),
    };

    let overlayPath = "";
    try {
      if (negativeCase.overlay !== undefined) {
        overlayPath = join(tempHome, "overlay.json");
        writeFileSync(overlayPath, JSON.stringify(negativeCase.overlay), "utf8");
      }

      const args = ["config", "-Json", ...negativeCase.buildArgs(overlayPath), "-RepositoryPath", REPO_ROOT];
      const psResult = runPwsh(args, env);
      const tsResult = runNode(args, env);

      assert.equal(psResult.exitCode, 2, `expected PowerShell to exit 2. stderr: ${psResult.stderr}`);
      assert.equal(tsResult.exitCode, 2, `expected TypeScript to exit 2. stderr: ${tsResult.stderr}`);

      const psText = firstLines(stripPsStderrDecoration(psResult.stderr), negativeCase.compareLines);
      const tsText = firstLines(tsResult.stderr, negativeCase.compareLines);
      if (negativeCase.expectedPrefix) {
        assert.ok(
          psText.startsWith(negativeCase.expectedPrefix),
          `expected PS stderr to start with '${negativeCase.expectedPrefix}': ${JSON.stringify(psText)}`,
        );
        assert.ok(
          tsText.startsWith(negativeCase.expectedPrefix),
          `expected TS stderr to start with '${negativeCase.expectedPrefix}': ${JSON.stringify(tsText)}`,
        );
      } else {
        assert.equal(
          tsText,
          psText,
          `stderr (first ${negativeCase.compareLines} line(s)) differ.\nPS (raw): ${JSON.stringify(psResult.stderr)}\nPS (stripped): ${JSON.stringify(psText)}\nTS: ${JSON.stringify(tsText)}`,
        );
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
}

test("config parity: -Profile Claude-Only resolves identically in both implementations", { skip: SKIP_REASON }, () => {
  const tempHome = mkdtempSync(join(tmpdir(), "hdo-config-parity-profile-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(tempHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(tempHome, "AppData", "Local"),
  };
  try {
    const args = ["config", "-Json", "-Profile", "Claude-Only", "-RepositoryPath", REPO_ROOT];
    const psResult = runPwsh(args, env);
    const tsResult = runNode(args, env);

    assert.equal(psResult.exitCode, 0, `PS failed unexpectedly. stderr: ${psResult.stderr}`);
    assert.equal(tsResult.exitCode, 0, `TS failed unexpectedly. stderr: ${tsResult.stderr}`);

    const psValue: unknown = JSON.parse(psResult.stdout);
    const tsValue: unknown = JSON.parse(tsResult.stdout);
    deleteGeneratedAt(psValue);
    deleteGeneratedAt(tsValue);

    assert.deepStrictEqual(canonicalize(tsValue), canonicalize(psValue));
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

for (const parityCase of CASES) {
  test(`config parity: ${parityCase.name}`, { skip: SKIP_REASON }, () => {
    // A fresh temp dir per case: nothing this repository's real %APPDATA%/%LOCALAPPDATA%
    // holds (a real user's hdo/config.json, for instance) should be able to leak in.
    const tempHome = mkdtempSync(join(tmpdir(), "hdo-config-parity-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDATA: join(tempHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(tempHome, "AppData", "Local"),
      };

      const args = ["config", "-Json", ...parityCase.args, "-RepositoryPath", REPO_ROOT];
      const psResult = runPwsh(args, env);
      const tsResult = runNode(args, env);

      // Every case in CASES is a known-good config (the same configs
      // schemaFixtures.test.ts / test-schemas.ps1 assert are schema-valid, run
      // through the actual default/repository config on disk) - PowerShell is
      // expected to accept all of them, so a non-zero PS exit here means the
      // oracle itself broke, not an intentional divergence to tolerate.
      assert.equal(psResult.exitCode, 0, `expected PowerShell to succeed for case '${parityCase.name}'. PS stderr: ${psResult.stderr}`);
      assert.equal(tsResult.exitCode, 0, `TS CLI failed unexpectedly. stderr: ${tsResult.stderr}\nstdout: ${tsResult.stdout}`);

      const psValue: unknown = JSON.parse(psResult.stdout);
      const tsValue: unknown = JSON.parse(tsResult.stdout);
      deleteGeneratedAt(psValue);
      deleteGeneratedAt(tsValue);

      assert.deepStrictEqual(
        canonicalize(tsValue),
        canonicalize(psValue),
        `TS and PowerShell 'config -Json' output differ for case '${parityCase.name}'.\nTS: ${JSON.stringify(tsValue, null, 2)}\nPS: ${JSON.stringify(psValue, null, 2)}`,
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
