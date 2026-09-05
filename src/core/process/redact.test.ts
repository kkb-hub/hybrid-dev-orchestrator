// Unit tests for the pure redaction logic, plus a pwsh-oracle parity test (AC-01):
// a corpus of strings/objects is run through both `protectText`/`protectObject` here
// and `Protect-HdoText`/`Protect-HdoObject` (Common.ps1) via the real PowerShell
// module, and the results must match exactly. Skipped when `pwsh` is not on PATH.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { protectObject, protectText } from "./redact.ts";

test("protectText: GitHub PAT (ghp_) is redacted", () => {
  assert.equal(protectText("token is ghp_1234567890abcdef1234"), "token is [REDACTED]");
});

test("protectText: Authorization Bearer header is redacted, prefix preserved", () => {
  assert.equal(protectText("Authorization: Bearer abc123def456"), "Authorization: Bearer [REDACTED]");
});

test("protectText: quoted JSON apiKey value is redacted, quotes preserved", () => {
  assert.equal(protectText('{"apiKey": "abcdef1234567890"}'), '{"apiKey": "[REDACTED]"}');
});

test("protectText: unquoted key=value is redacted up to the next comma/brace/space", () => {
  assert.equal(protectText("token=abc123,next=value"), "token=[REDACTED],next=value");
});

test("protectText: null passes through as null", () => {
  assert.equal(protectText(null), null);
});

test("protectText: a near-miss ('tokens', not 'token=') is left untouched", () => {
  assert.equal(protectText("tokens are stored securely"), "tokens are stored securely");
});

// S-9: JS `.` (no `s`/dotAll flag) excludes `\r`/U+2028/U+2029 in addition to `\n`,
// while .NET `.` (no RegexOptions.Singleline) excludes only `\n` - so a raw CR or
// U+2028 immediately after a backslash inside a quoted value used to stop the
// `(?:\\.|[^"\\])*` body from consuming it, breaking the match (or the whole
// pattern) entirely and leaving the secret unredacted.
test("protectText: a CR immediately after a backslash inside a quoted token value is still redacted", () => {
  assert.equal(protectText('{"token":"ab\\\rcd"}'), '{"token":"[REDACTED]"}');
});

test("protectText: U+2028 (LINE SEPARATOR) immediately after a backslash inside a quoted token value is still redacted", () => {
  assert.equal(protectText('{"token":"ab\\\u2028cd"}'), '{"token":"[REDACTED]"}');
});

test("protectText: an unquoted-key quoted token value containing a CR is redacted as a whole, not partially", () => {
  assert.equal(protectText('token="ab\\\rcd"'), 'token="[REDACTED]"');
});

// S-9: JS `\s` excludes U+0085 (NEL), which .NET's `\s` includes - a NEL used as the
// separator between "token:" and its value used to not match here at all.
test("protectText: U+0085 (NEL) as the MANDATORY separator after \"Bearer\" is still recognized as whitespace", () => {
  assert.equal(protectText("authorization:tokenabc123def456"), "authorization:token[REDACTED]");
});

test("protectObject: redacts by key name regardless of value shape, preserves key order", () => {
  const result = protectObject({ apiKey: "sk-proj-1234567890abcdef", note: "safe text" });
  assert.deepEqual(result, { apiKey: "[REDACTED]", note: "safe text" });
  assert.deepEqual(Object.keys(result as object), ["apiKey", "note"]);
});

test("protectObject: recurses into arrays and nested objects", () => {
  const result = protectObject({
    user: { name: "alice", token: "ghp_abcdefghijklmnop" },
    tags: ["ok", "password=abc123"],
  });
  assert.deepEqual(result, {
    user: { name: "alice", token: "[REDACTED]" },
    tags: ["ok", "password=[REDACTED]"],
  });
});

test("protectObject: null/undefined/primitives pass through unchanged", () => {
  assert.equal(protectObject(null), null);
  assert.equal(protectObject(undefined), undefined);
  assert.equal(protectObject(5), 5);
  assert.equal(protectObject(true), true);
});

// --- pwsh oracle parity ------------------------------------------------------

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

function detectPwsh(): boolean {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return !probe.error && probe.status === 0;
}

const PWSH_AVAILABLE = detectPwsh();
const SKIP_REASON = PWSH_AVAILABLE ? false : "pwsh is not on PATH";

// ~20 strings covering: GitHub PAT, Claude/OpenAI-style keys, Slack token, Authorization
// headers (including a near-miss the PowerShell character class deliberately does NOT
// redact - a trailing quote right after "Bearer "), quoted/unquoted JSON key=value
// forms, single-quoted values with spaces, already-redacted text (idempotence), near
// misses on the key name ("tokens", "pw", bare "key"), and multi-line text.
const TEXT_CORPUS: string[] = [
  "ghp_1234567890abcdef1234",
  "github_pat_11ABCDEFG0123456789012_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  "xoxb-1234567890-abcdefghijklmnop",
  "Authorization: Bearer abc123def456",
  "authorization:bearer abc123",
  // Near miss: PowerShell's char class `[^\s"']+` excludes a leading quote, so a
  // quoted Bearer token is NOT redacted by this pattern (and "Authorization" does not
  // itself contain "token"/"password"/etc., so no other pattern catches it either).
  'Authorization: Bearer "quoted-token-value"',
  '{"apiKey": "abcdef1234567890"}',
  '{"api_key": "abcdef1234567890", "unrelated": "value"}',
  "token=abc123",
  "token=abc123,next=value",
  "password: 'x y'",
  'credential="a=b;c=d"',
  "My token is already [REDACTED] here",
  "tokens are stored securely",
  "pw=abc",
  "key=abc",
  "line one\napiKey: sk-test-1234567890\nline three",
  'secret: "value ends here"',
  "plain text with no credentials at all",
  // S-9 parity additions: CR/U+2028 (LINE SEPARATOR) immediately after a
  // backslash inside a quoted value, U+0085 (NEL) as a mandatory separator, and
  // U+FEFF (BOM) as ordinary (non-whitespace) value content.
  '{"token":"ab\\\rcd"}',
  '{"token":"ab\\\u2028cd"}',
  "authorization:token" + String.fromCharCode(0x85) + "abc123def456",
  "token:" + String.fromCharCode(0xfeff) + "abc123",
];

const OBJECT_CORPUS: unknown[] = [
  { apiKey: "sk-proj-1234567890abcdef", note: "safe text" },
  {
    user: { name: "alice", token: "ghp_abcdefghijklmnop" },
    tags: ["ok", "token=xyz123"],
  },
  { count: 5, active: true, missing: null },
  ["password=abc123", "ok"],
];

interface RedactionOracleResult {
  texts: string[];
  objects: unknown[];
}

// Invokes the real PowerShell module (private, un-exported functions) the same way
// tests/test-process-output.ps1 does: `& $module { scriptblock }` runs the scriptblock
// inside the module's own session state, giving it access to `Protect-HdoText`/
// `Protect-HdoObject` without exporting them.
const ORACLE_SCRIPT = `
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [Parameter(Mandatory)][string]$InputPath,
    [Parameter(Mandatory)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $RepositoryRoot 'src/HybridDevOrchestrator/HybridDevOrchestrator.psd1') -Force
$module = Get-Module HybridDevOrchestrator
$payload = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json -Depth 100
$textResults = & $module {
    param($Texts)
    $out = [Collections.Generic.List[object]]::new()
    foreach ($t in @($Texts)) { $out.Add((Protect-HdoText $t)) }
    return ,$out.ToArray()
} $payload.texts
$objectResults = & $module {
    param($Objs)
    $out = [Collections.Generic.List[object]]::new()
    foreach ($o in @($Objs)) { $out.Add((Protect-HdoObject $o)) }
    return ,$out.ToArray()
} $payload.objects
$result = [ordered]@{ texts = @($textResults); objects = @($objectResults) }
$result | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
`;

function runOracle(texts: string[], objects: unknown[]): RedactionOracleResult {
  const tempDir = mkdtempSync(join(tmpdir(), "hdo-redact-parity-"));
  try {
    const scriptPath = join(tempDir, "oracle.ps1");
    const inputPath = join(tempDir, "input.json");
    const outputPath = join(tempDir, "output.json");
    writeFileSync(scriptPath, ORACLE_SCRIPT, "utf8");
    writeFileSync(inputPath, JSON.stringify({ texts, objects }), "utf8");
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-File", scriptPath, "-RepositoryRoot", REPO_ROOT, "-InputPath", inputPath, "-OutputPath", outputPath],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, `oracle script failed: ${result.stderr}\n${result.stdout}`);
    const raw = readFileSync(outputPath, "utf8");
    return JSON.parse(raw) as RedactionOracleResult;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("protectText matches Protect-HdoText for the redaction corpus (pwsh oracle)", { skip: SKIP_REASON }, () => {
  const oracle = runOracle(TEXT_CORPUS, []);
  const tsResults = TEXT_CORPUS.map((text) => protectText(text));
  assert.deepStrictEqual(
    tsResults,
    oracle.texts,
    `protectText output differs from Protect-HdoText.\nInputs: ${JSON.stringify(TEXT_CORPUS, null, 2)}\nTS: ${JSON.stringify(tsResults, null, 2)}\nPS: ${JSON.stringify(oracle.texts, null, 2)}`,
  );
});

test("protectObject matches Protect-HdoObject for the redaction corpus (pwsh oracle)", { skip: SKIP_REASON }, () => {
  const oracle = runOracle([], OBJECT_CORPUS);
  const tsResults = OBJECT_CORPUS.map((value) => protectObject(value));
  assert.deepStrictEqual(
    tsResults,
    oracle.objects,
    `protectObject output differs from Protect-HdoObject.\nInputs: ${JSON.stringify(OBJECT_CORPUS, null, 2)}\nTS: ${JSON.stringify(tsResults, null, 2)}\nPS: ${JSON.stringify(oracle.objects, null, 2)}`,
  );
});
