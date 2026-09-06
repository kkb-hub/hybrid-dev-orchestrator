// Pure cmd.exe command-line builder for `.cmd`/`.bat` shims (ADR-0001 phase 5,
// WP-D). Node's `spawn()` throws synchronously (`EINVAL`, CVE-2024-27980) for a bare
// `.cmd`/`.bat` target unless `shell: true` is set, and `NodeProcessRunner` never sets
// `shell: true`. The alternative this module implements instead: spawn `cmd.exe`
// directly with `['/d', '/s', '/v:off', '/c', '"<line>"']` (see `src/process/runner.ts`),
// where `<line>` is a single command-line string this module builds and validates -
// never handed to a shell that re-interprets metacharacters from untrusted argument
// text.
//
// `.NET Process.Start` (PowerShell's `Invoke-HdoProcess`, Common.ps1:744-847) lets
// `CreateProcess` itself fall back to cmd.exe for a `.cmd`/`.bat` target, with NO
// metacharacter protection at all - which is exactly why `Test-HdoEnvironment`
// (Workflow.ps1:50-56) warns operators that a `.cmd` claude shim can corrupt the
// inline `--json-schema` argument. This module closes that gap for the TypeScript
// side by rejecting anything it cannot pass through safely, rather than silently
// corrupting it.
//
// Quoting: each argument is quoted per the MSVCRT/CommandLineToArgvW rules (the same
// rules .NET's `ProcessStartInfo.ArgumentList` and Node's own `.exe` argv quoting
// apply) - see `quoteMsvcrtArgument`. The shim PATH is always wrapped in a plain
// `"..."` (Windows paths cannot contain a `"`, so this is never ambiguous) and is
// NEVER caret-escaped: unlike an argument, the shim path is parsed by cmd.exe exactly
// ONCE (it is the command token of the `/c` line, never re-parsed by the batch file's
// own `%*` expansion), so caret-escaping it - meant to survive a SECOND parse, see
// below - would corrupt it instead of protecting it (an unescaped `(`/`)`/`&`/... in a
// quoted path is otherwise completely inert to cmd.exe).
//
// cmd.exe re-parses the whole line a SECOND time for a `.cmd`/`.bat` target's
// arguments (once for its own `/c` parse, again when the batch file's own `%*`
// expands - the same two-parse structure npm's own `cmd-shim` package's generated
// shims rely on), so cmd.exe's own metacharacters (`& | < > ^ ! ( )`) must
// additionally be neutralized wherever they are not already inside a real,
// MSVCRT-quoted region.
//
// Deciding "inside or outside a quoted region" is NOT a per-argument question: cmd.exe
// toggles a SINGLE quote-parity flag on every `"` it sees, cumulatively across the
// WHOLE line (shim path included), and it does not understand MSVCRT's `\"` as an
// escape at all - `\"` is just a literal backslash followed by a quote character, and
// that quote character still toggles the flag exactly like any other. An earlier
// version of this module reasoned per-argument ("this one argument contains both a
// `"` and a metacharacter, therefore reject it") and documented the mixed case as
// "undecidable" - that reasoning was wrong, not just incomplete: an argument whose
// MSVCRT-quoted form contains an ODD number of `"` (e.g. `a"` quotes to `"a\""`, three
// `"` characters total) leaves cmd.exe's own parser in the OPEN quote state after
// that argument ends, so the metacharacters of the very NEXT argument - even one that
// looks perfectly safe in isolation (whitespace-quoted, no `"` at all) - are live and
// can inject a second command. It IS fully decidable once quote parity is tracked
// cumulatively across every character that will actually appear on the line, in
// order: walk the shim path token, then each MSVCRT-quoted argument token in turn,
// flip a `parity` bit on every `"`, and caret-escape a metacharacter iff `parity` is
// currently even ("outside quotes", from cmd.exe's point of view) at that exact
// character. `buildCmdShimCommandLine` below does exactly this; see its own comment
// for why each escaped metacharacter gets three carets, not one.
//
// Rejections (all enforced before any process is spawned):
// - `%`/CR/LF/NUL/other C0 control characters (except tab) anywhere (the shim path or
//   any argument): cmd.exe's `%VAR%` expansion (on the command line AND again in the
//   batch file's own `%*` re-parse) cannot be escaped reliably; a literal CR/LF would
//   terminate/split the `/c "<line>"` command line early; a NUL byte is rejected
//   *here*, before Node's own `spawn()` throws a much noisier `ERR_INVALID_ARG_VALUE`
//   for it (review round 2 nit 4); other C0 controls are rejected defensively even
//   though they were measured to round-trip byte-exactly through a real cmd.exe
//   (review round 2 nit 4 evidence) - tab is exempted since it is a completely
//   ordinary, frequently-legitimate argument character.
// - A total REAL command line longer than 8191 characters - the documented cmd.exe
//   command-line limit. "Real" is the operative word (review round 2 should-fix 2):
//   this is the FULL text `CreateProcess` actually receives, i.e. `<spawnFile> /d /s
//   /v:off /c "<line>"` where `<spawnFile>` is the resolved COMSPEC path - not a
//   placeholder 7-character `cmd.exe` literal. Measured empirically
//   (`spawnFile.length` varies with the COMSPEC value, e.g. 27 for
//   `C:\Windows\system32\cmd.exe`): a real spawn succeeds up to exactly 8191 total
//   characters and fails (ordinary `exitCode: 1`, CP932 "コマンド ラインが長すぎます。"
//   on stderr - NOT a pre-spawn rejection) at 8192. The shim's OWN batch body does NOT
//   move this ceiling - two shims whose bodies differed by dozens of characters
//   (a one-line `echo %*` vs. a `node.exe ... %*` wrapper) had IDENTICAL real limits
//   once the `spawnFile` length was accounted for; only `spawnFile`'s own length
//   changes the budget. Callers MUST supply the real prefix via
//   `options.commandLinePrefix` (see `buildCmdShimCommandLine`'s own doc comment) -
//   the module-internal default below is only representative, for pure/offline tests.
export const CMD_SHIM_EXTENSION_PATTERN = /\.(cmd|bat)$/i;

const CMD_METACHARACTERS = /[&|<>^!()]/;

// C0 control characters (U+0000-U+001F) other than tab (U+0009); CR (U+000D) and LF
// (U+000A) are rejected separately, with their own more specific message, below.
const OTHER_C0_CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

// A representative COMSPEC value + the exact fixed text `runner.ts` places between
// the resolved `spawnFile` and this function's own quoted `line` - used only as this
// function's default `commandLinePrefix` (pure/offline callers, including this
// module's own tests); `src/process/runner.ts` always passes the ACTUAL resolved
// `spawnFile` instead (review round 2 should-fix 2).
export const DEFAULT_COMMAND_LINE_PREFIX = 'C:\\Windows\\System32\\cmd.exe /d /s /v:off /c "';

function shimRejection(shimPath: string, reason: string): Error {
  return new Error(`The shim path or an argument cannot be passed safely through the batch shim '${shimPath}': ${reason}`);
}

/**
 * review round 2 nit 7: names which value tripped the rejection - the shim path
 * itself (`valueIndex === 0` in `values` below) or a specific argument (`valueIndex -
 * 1` is the 0-based `args` index) - since the two were otherwise indistinguishable
 * from the shared message prefix alone.
 */
function rejectValue(shimPath: string, valueIndex: number, reason: string): Error {
  const subject = valueIndex === 0 ? "the shim path" : `argument ${valueIndex - 1}`;
  return shimRejection(shimPath, `${subject} ${reason}`);
}

/**
 * MSVCRT/CommandLineToArgvW argument quoting: empty -> `""`; an argument with no
 * whitespace and no `"` is passed through unquoted (matches what .NET's
 * `ArgumentList`/Node's own `.exe` argv quoting do for the common case, so a shim that
 * already works via PowerShell keeps working byte-for-byte for plain arguments); any
 * other argument is wrapped in `"..."`, with each `"` escaped to `\"` and any run of
 * backslashes immediately preceding a `"` (embedded or the closing one) doubled -
 * a lone trailing backslash with nothing else needing quoting is NOT doubled (it is
 * not adjacent to a `"` at all in that case, since the argument is returned unquoted).
 */
export function quoteMsvcrtArgument(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;

  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  // A trailing run of backslashes (before the closing quote this function itself
  // adds) must be doubled too - the closing `"` is just as much a quote character to
  // MSVCRT's parser as any embedded one.
  result += "\\".repeat(backslashes * 2) + '"';
  return result;
}

export interface BuildCmdShimCommandLineOptions {
  /**
   * The literal text that will precede this function's own opening `"` (of
   * `"<line>"`) in the REAL command line `CreateProcess` receives - i.e.
   * `<spawnFile> /d /s /v:off /c "` where `<spawnFile>` is the resolved COMSPEC
   * path `src/process/runner.ts` is about to spawn. Defaults to
   * `DEFAULT_COMMAND_LINE_PREFIX` (a representative COMSPEC value) so this function
   * stays usable standalone/in tests; a real caller MUST pass the actual prefix, or
   * the 8191-character check below measures the wrong line and can accept a command
   * that fails at spawn time instead (review round 2 should-fix 2).
   */
  commandLinePrefix?: string;
}

/**
 * Builds the single command-line string to place inside `<spawnFile> /d /s /v:off /c
 * "<line>"` for invoking the `.cmd`/`.bat` shim at `shimPath` with `args`, or throws
 * if the shim path or any argument cannot be passed through safely. See the module
 * banner for the full rejection rationale and the quote-parity algorithm; every
 * thrown message starts with `The shim path or an argument cannot be passed safely
 * through the batch shim '<shimPath>': `.
 */
export function buildCmdShimCommandLine(shimPath: string, args: readonly string[], options: BuildCmdShimCommandLineOptions = {}): string {
  const values = [shimPath, ...args];

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    // review round 2 nit 4: a NUL byte is caught HERE, before Node's own `spawn()`
    // throws a much noisier `ERR_INVALID_ARG_VALUE` (whose message echoes the ENTIRE
    // command line) for it.
    if (value.includes("\0")) throw rejectValue(shimPath, i, "contains a NUL character");
    if (value.includes("%")) throw rejectValue(shimPath, i, "contains a percent sign");
    if (value.includes("\r") || value.includes("\n")) throw rejectValue(shimPath, i, "contains a line break");
    // review round 2 nit 4: every OTHER C0 control character (tab excepted) is
    // rejected defensively here too, even though these were measured to round-trip
    // byte-exactly through a real cmd.exe - see the module banner.
    if (OTHER_C0_CONTROL_CHARACTERS.test(value)) throw rejectValue(shimPath, i, "contains a control character");
  }
  // Windows paths can never legitimately contain a `"` - this can only fire on a
  // caller error, but it keeps the "shim path is always quoted, never escaped"
  // invariant airtight rather than silently building a malformed command line.
  if (shimPath.includes('"')) throw shimRejection(shimPath, "the shim path contains a double quote");

  // The shim path is quoted but NEVER caret-escaped (see module banner: it is parsed
  // by cmd.exe exactly once). Every argument is MSVCRT-quoted; whether ITS
  // metacharacters need a caret-escape depends on cmd.exe's cumulative quote parity
  // at that exact character - tracked below across the WHOLE line, in the exact
  // order the tokens will appear, never re-derived per argument in isolation (see
  // module banner for why per-argument reasoning was unsound).
  const tokens = [`"${shimPath}"`, ...args.map(quoteMsvcrtArgument)];
  let parity = 0; // cmd.exe's quote-state toggle across the whole line: 0 = outside quotes, 1 = inside
  const parts: string[] = [];
  for (const token of tokens) {
    let escaped = "";
    for (const char of token) {
      if (char === '"') {
        parity ^= 1;
        escaped += char;
        continue;
      }
      // Caret-escaping a metacharacter TWICE (three carets total, e.g. `&` becomes
      // `^^^&`) is what was verified empirically to survive BOTH parses a
      // `.cmd`/`.bat` argument goes through - cmd.exe's own `/c` parse, and the
      // shim's own re-parse when its batch body expands `%*` (a single-caret escape
      // survives only the first parse; see cmdShim.test.ts for the round-trip that
      // pins this). It is applied per-character here, rather than as a separate
      // whole-string pass, precisely so it can be gated on `parity` at each
      // character: only when parity is even (cmd.exe considers this position
      // "outside quotes") does caret-escaping have any protective effect at all -
      // inside a real quoted region a caret is just another literal character, and
      // escaping it there would corrupt the value instead of protecting it.
      escaped += CMD_METACHARACTERS.test(char) && parity === 0 ? `^^^${char}` : char;
    }
    parts.push(escaped);
  }

  const line = parts.join(" ");
  // review round 2 should-fix 2: measured against the REAL prefix (see
  // `BuildCmdShimCommandLineOptions.commandLinePrefix`'s doc comment and the module
  // banner), not a placeholder `cmd.exe /d /s /c "` literal - `+ 1` is the closing
  // `"` this function's own `<line>` sits inside of, which is not part of
  // `commandLinePrefix` itself.
  const commandLinePrefix = options.commandLinePrefix ?? DEFAULT_COMMAND_LINE_PREFIX;
  const totalLength = commandLinePrefix.length + line.length + 1;
  if (totalLength > 8191) {
    throw shimRejection(shimPath, `command line exceeds the 8191-character cmd.exe limit (${totalLength} characters)`);
  }
  return line;
}
