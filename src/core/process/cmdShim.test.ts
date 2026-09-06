import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildCmdShimCommandLine, CMD_SHIM_EXTENSION_PATTERN, DEFAULT_COMMAND_LINE_PREFIX, quoteMsvcrtArgument } from "./cmdShim.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

function readSchema(name: string): string {
  return JSON.stringify(JSON.parse(readFileSync(resolve(REPO_ROOT, "schemas", name), "utf8")));
}

test("CMD_SHIM_EXTENSION_PATTERN matches .cmd/.bat case-insensitively and nothing else", () => {
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude.cmd"), true);
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude.CMD"), true);
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude.bat"), true);
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude.BAT"), true);
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude.exe"), false);
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude.ps1"), false);
  assert.equal(CMD_SHIM_EXTENSION_PATTERN.test("claude"), false);
});

test("quoteMsvcrtArgument: quoting table", () => {
  assert.equal(quoteMsvcrtArgument("abc"), "abc");
  assert.equal(quoteMsvcrtArgument("a b"), '"a b"');
  assert.equal(quoteMsvcrtArgument('a"b'), '"a\\"b"');
  assert.equal(quoteMsvcrtArgument("a\\"), "a\\", "a lone trailing backslash with nothing else needing quoting stays unquoted");
  assert.equal(quoteMsvcrtArgument("a b\\"), '"a b\\\\"', "a trailing backslash IS doubled once quoting is otherwise required");
  assert.equal(quoteMsvcrtArgument(""), '""');
  // x\"y: a backslash immediately preceding an embedded quote is doubled (3 total:
  // the 1 already there, doubled, plus the 1 that escapes the quote itself), then the
  // quote itself is escaped - built programmatically here to avoid a hand-escaped,
  // easy-to-miscount JS string literal.
  const expectedXQuoteY = '"' + "x" + "\\".repeat(3) + '"' + "y" + '"';
  assert.equal(quoteMsvcrtArgument('x\\"y'), expectedXQuoteY);
});

test("buildCmdShimCommandLine: the shim path is always quoted, never caret-escaped", () => {
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["plain"]), '"shim.cmd" plain');
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["two words"]), '"shim.cmd" "two words"');
  assert.equal(buildCmdShimCommandLine("shim.cmd", [""]), '"shim.cmd" ""');
  // S-1: a metacharacter/comma/semicolon in the shim path's directory name must
  // survive unescaped, since quoting alone (not caret-escaping) protects the command
  // token - which is parsed by cmd.exe exactly once.
  assert.equal(buildCmdShimCommandLine("C:\\x(1)\\shim.cmd", ["arg"]), '"C:\\x(1)\\shim.cmd" arg');
  assert.equal(buildCmdShimCommandLine("C:\\a,b\\shim.cmd", ["arg"]), '"C:\\a,b\\shim.cmd" arg');
  assert.equal(buildCmdShimCommandLine("C:\\a&b\\shim.cmd", ["arg"]), '"C:\\a&b\\shim.cmd" arg');
});

test("buildCmdShimCommandLine: an unquoted metacharacter is escaped by applying the single-caret escape twice (3 carets total), verified empirically to survive both cmd.exe parses", () => {
  // See cmdShim.ts's module banner: applying the escape TWICE per character - not
  // hand-doubling each caret in one pass - is what actually survives both the outer
  // `cmd.exe /d /s /c` parse and the shim's own `%*` re-parse; this was verified
  // against a real `cmd.exe` invocation of the two-level shim wrapper
  // `src/process/runner.ts` builds.
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["a&b"]), '"shim.cmd" a^^^&b');
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["a|b"]), '"shim.cmd" a^^^|b');
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["a(b)"]), '"shim.cmd" a^^^(b^^^)');
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["a^b"]), '"shim.cmd" a^^^^b');
});

test("buildCmdShimCommandLine: a metacharacter alongside whitespace is protected by MSVCRT quoting alone, with NO caret escaping applied", () => {
  // Once whitespace forces `quoteMsvcrtArgument` to wrap the value in a real `"..."`
  // region, cmd.exe's caret-escape has no effect there (the caret becomes a literal
  // character) - applying it anyway would corrupt the value, so it must be skipped
  // whenever cmd.exe's cumulative quote parity is "inside quotes" at that character
  // (verified empirically).
  assert.equal(buildCmdShimCommandLine("shim.cmd", ["a & b"]), '"shim.cmd" "a & b"');
});

test("buildCmdShimCommandLine: rejects any value containing a percent sign, naming the shim path or the argument index (review round 2 nit 7)", () => {
  assert.throws(
    () => buildCmdShimCommandLine("shim.cmd", ["50%"]),
    /^Error: The shim path or an argument cannot be passed safely through the batch shim 'shim\.cmd': argument 0 contains a percent sign$/,
  );
  // The shim path itself is checked too - and the message says so, not "argument 0".
  assert.throws(
    () => buildCmdShimCommandLine("C:\\shims\\100%claude.cmd", ["arg"]),
    /^Error: The shim path or an argument cannot be passed safely through the batch shim 'C:\\shims\\100%claude\.cmd': the shim path contains a percent sign$/,
  );
  // A later argument's index is 0-based and independent of the shim path.
  assert.throws(
    () => buildCmdShimCommandLine("shim.cmd", ["ok", "50%"]),
    /: argument 1 contains a percent sign$/,
  );
});

test("buildCmdShimCommandLine: rejects any value containing a line break (CR or LF), naming the shim path or the argument index", () => {
  assert.throws(
    () => buildCmdShimCommandLine("shim.cmd", ["a\r\nb"]),
    /^Error: The shim path or an argument cannot be passed safely through the batch shim 'shim\.cmd': argument 0 contains a line break$/,
  );
  assert.throws(() => buildCmdShimCommandLine("shim.cmd", ["a\nb"]), /: argument 0 contains a line break$/);
  assert.throws(() => buildCmdShimCommandLine("shim.cmd", ["a\rb"]), /: argument 0 contains a line break$/);
});

test("buildCmdShimCommandLine: rejects a shim path containing a double quote", () => {
  assert.throws(
    () => buildCmdShimCommandLine('C:\\shims\\"claude.cmd', ["arg"]),
    /^Error: The shim path or an argument cannot be passed safely through the batch shim 'C:\\shims\\"claude\.cmd': the shim path contains a double quote$/,
  );
});

// review round 2 nit 4: a NUL byte is caught by the builder (a clear, pre-spawn
// rejection) instead of reaching Node's own `spawn()`, which throws a much noisier
// `ERR_INVALID_ARG_VALUE` that echoes the entire command line.
test("buildCmdShimCommandLine: rejects any value containing a NUL byte", () => {
  assert.throws(
    () => buildCmdShimCommandLine("shim.cmd", ["a\u0000b"]),
    /^Error: The shim path or an argument cannot be passed safely through the batch shim 'shim\.cmd': argument 0 contains a NUL character$/,
  );
});

// review round 2 nit 4: every other C0 control character (tab excepted) is rejected
// defensively too, even though these were measured to round-trip byte-exactly
// through a real cmd.exe (see the module banner) - tab itself must NOT be rejected.
test("buildCmdShimCommandLine: rejects other C0 control characters but accepts tab", () => {
  for (const char of ["\u0001", "\u001a", "\u001b", "\u000b", "\u000c"]) {
    assert.throws(
      () => buildCmdShimCommandLine("shim.cmd", [`a${char}b`]),
      /: argument 0 contains a control character$/,
      `expected U+${char.charCodeAt(0).toString(16).padStart(4, "0")} to be rejected`,
    );
  }
  assert.doesNotThrow(() => buildCmdShimCommandLine("shim.cmd", ["a\tb"]));
});

// B-1: an argument mixing '"' with a cmd.exe metacharacter is now ACCEPTED (the
// per-argument "mixes double quotes with cmd.exe metacharacters" rejection is gone),
// and - crucially - so is every argument that FOLLOWS one whose MSVCRT-quoted form
// leaves cmd.exe's cumulative quote parity open. Each assertion below pins the EXACT
// produced line (a pure builder assertion, no process spawned); runner.test.ts proves
// the same vectors never actually inject a command via a real cmd.exe.
test("buildCmdShimCommandLine: B-1 cross-argument quote-parity vectors round-trip through the exact expected line, no rejection", () => {
  // Each expected line below was independently produced by driving the built line
  // through a real `cmd.exe /d /s /v:off /c` invocation (see runner.test.ts's
  // "B-1 marker-file injection" test for the live-process half of this proof) - this
  // test pins the pure builder output byte-for-byte, so any regression in the
  // quote-parity tracking is caught without spawning a process.
  //
  // ['a"', 'x y&whoami']: the first argument's MSVCRT-quoted form ("a\"") contains an
  // ODD number of '"' (3), leaving cmd.exe's cumulative quote parity OPEN after it -
  // this is exactly the B-1 bug. The second argument's own leading '"' immediately
  // closes that parity again (still inside the SAME MSVCRT-quoted region cmd.exe
  // never distinguishes from the first), so the '&' that follows is evaluated at
  // parity 0 ("outside quotes") and correctly caret-escaped - never left live for
  // cmd.exe to split into a second command.
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['a"', "x y&whoami"]), '"shim.cmd" "a\\"" "x y^^^&whoami"');
  assert.equal(
    buildCmdShimCommandLine("shim.cmd", ['{"a":"x\\"y"}', "safe arg&echo INJECTED2"]),
    '"shim.cmd" "{\\"a\\":\\"x\\\\\\"y\\"}" "safe arg^^^&echo INJECTED2"',
  );
  // ['"', '&whoami']: the lone '"' argument quotes to an ODD-count token ("\""), so
  // parity is OPEN entering the second argument. '&whoami' has no whitespace/quote of
  // its own, so `quoteMsvcrtArgument` returns it UNQUOTED - its '&' is then evaluated
  // at parity 1 ("inside quotes" from cmd.exe's point of view, which is genuinely true
  // here: cmd.exe's own parser is still inside the quoted region the first argument
  // opened), so it is correctly left UNESCAPED - a real quoted region already makes it
  // inert, and caret-escaping it there would be both unnecessary and wrong.
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['"', "&whoami"]), '"shim.cmd" "\\"" &whoami');
  // ['a"b', '(x)']: same shape as above with a different metacharacter - '(x)' is
  // unquoted (no whitespace/quote) and evaluated entirely at parity 1, so it survives
  // untouched, protected by the still-open quoted region from the first argument.
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['a"b', "(x)"]), '"shim.cmd" "a\\"b" (x)');
  // Single-argument vectors where the odd-quote-count and the metacharacter are both
  // inside the SAME MSVCRT-quoted token: the metacharacter is reached while parity is
  // still 0 (the token's own opening '"' having just flipped it), so it IS escaped.
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['x" & whoami']), '"shim.cmd" "x\\" ^^^& whoami"');
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['" & whoami & "']), '"shim.cmd" "\\" ^^^& whoami ^^^& \\""');
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['a\\"&whoami']), '"shim.cmd" "a\\\\\\"^^^&whoami"');
  // ['x"y"z&whoami']: an EVEN number of embedded quotes (2) inside one argument keeps
  // parity closed (real quoted region) by the time '&' is reached, so no escape is
  // applied and none is needed - the '&' is genuinely inside quotes.
  assert.equal(buildCmdShimCommandLine("shim.cmd", ['x"y"z&whoami']), '"shim.cmd" "x\\"y\\"z&whoami"');
});

test("buildCmdShimCommandLine: review-result transport schema JSON ('\"' and '^' together) round-trips instead of being rejected", () => {
  const reviewResultJson = readSchema("review-result.schema.json");
  assert.ok(reviewResultJson.includes('"'));
  assert.ok(reviewResultJson.includes("^"));
  const line = buildCmdShimCommandLine("shim.cmd", [reviewResultJson]);
  assert.ok(line.startsWith('"shim.cmd" '));
});

test("buildCmdShimCommandLine: task-contract and worker-result transport schema JSON (quotes, no metacharacters) round-trip", () => {
  for (const name of ["task-contract.schema.json", "worker-result.schema.json"]) {
    const json = readSchema(name);
    assert.ok(json.includes('"'));
    assert.ok(!/[&|<>^!()]/.test(json), `expected ${name} to contain no cmd.exe metacharacters`);
    const line = buildCmdShimCommandLine("shim.cmd", [json]);
    assert.ok(line.startsWith('"shim.cmd" '));
  }
});

test("buildCmdShimCommandLine: total REAL command line at exactly 8191 characters is accepted, 8192 is rejected (review round 2 should-fix 2)", () => {
  // review round 2 should-fix 2: the check is measured against
  // `commandLinePrefix.length + line.length + 1` (the `+ 1` is the closing quote
  // after `<line>`, which is not part of `commandLinePrefix` itself), never a
  // placeholder literal - `DEFAULT_COMMAND_LINE_PREFIX` here stands in for the real
  // resolved COMSPEC path `src/process/runner.ts` always passes instead (proved
  // against a REAL cmd.exe in runner.test.ts: an argument just under this limit
  // runs to completion byte-exact, one just over is rejected here, before spawn).
  //
  // line = `"shim.cmd"` (10, always quoted) + " " (1) + "a"*N (unquoted, no
  // whitespace/quote) = 11 + N; total = prefixLength + line.length + 1
  // = prefixLength + 12 + N. Solving total = 8191 for N:
  const prefixLength = DEFAULT_COMMAND_LINE_PREFIX.length;
  const atLimitN = 8191 - prefixLength - 12;

  const atLimit = "a".repeat(atLimitN);
  const line = buildCmdShimCommandLine("shim.cmd", [atLimit], { commandLinePrefix: DEFAULT_COMMAND_LINE_PREFIX });
  assert.equal(prefixLength + line.length + 1, 8191);

  const overLimit = "a".repeat(atLimitN + 1);
  assert.throws(
    () => buildCmdShimCommandLine("shim.cmd", [overLimit], { commandLinePrefix: DEFAULT_COMMAND_LINE_PREFIX }),
    /^Error: The shim path or an argument cannot be passed safely through the batch shim 'shim\.cmd': command line exceeds the 8191-character cmd\.exe limit \(8192 characters\)$/,
  );
});

test("buildCmdShimCommandLine: the default commandLinePrefix is DEFAULT_COMMAND_LINE_PREFIX when no options are passed", () => {
  const atLimitN = 8191 - DEFAULT_COMMAND_LINE_PREFIX.length - 12;
  const withDefault = buildCmdShimCommandLine("shim.cmd", ["a".repeat(atLimitN)]);
  const withExplicitDefault = buildCmdShimCommandLine("shim.cmd", ["a".repeat(atLimitN)], { commandLinePrefix: DEFAULT_COMMAND_LINE_PREFIX });
  assert.equal(withDefault, withExplicitDefault);
  assert.throws(() => buildCmdShimCommandLine("shim.cmd", ["a".repeat(atLimitN + 1)]));
});
