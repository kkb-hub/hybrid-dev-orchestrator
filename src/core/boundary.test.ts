// Mechanically enforces the core/platform boundary described in ADR-0001 and
// docs/evaluation/typescript-architecture-proposal.md section 3: nothing under
// `src/core/**` (excluding all `*.test.ts` files under core, this file included) may
// import a host-specific module or reach "up and out" into platform/process/git/cli.
// Every *test* file under core is exempted from its own rule by `listSourceFiles`'s
// `.test.ts` filter below: a test that inspects source text is allowed to use
// `node:fs`/`node:path` to do so, because it never ships as part of the pure core
// surface that the rest of the program depends on. Ported from
// poc/typescript/src/core/boundary.test.ts, adjusted only to scan this production
// tree (`src/core/**`) instead of the PoC's `poc/typescript/src/core/**`.
//
// F-08: the previous version of this check only inspected lines that *started* with
// `import` or `export ... from`, so it missed: dynamic `import(...)`, `require(...)`,
// `createRequire`, and multi-line `import {\n  ...\n} from '...'` (whose `from` line
// does not start with the word "import"). This version scans the whole file's text
// with regexes instead of a line-prefix heuristic, and a negative self-test below
// feeds each bypass form to the extracted predicate directly (as strings, not files)
// to prove it is actually caught.
//
// H-02: a bare side-effect import (`import "node:fs";`, with no `from` clause at all)
// was also missed by every pattern above - `IMPORT_FROM_PATTERN` requires a `from`
// keyword, and none of the other patterns match plain `import "...";` either.
// `SIDE_EFFECT_IMPORT_PATTERN` below closes that gap. It requires the literal word
// `import` immediately (modulo optional whitespace) followed by a quote, which is
// exactly what a side-effect-only import looks like and what `import x from "y"`/
// `import { x } from "y"`/`import type { x } from "y"` do not: in each of those, the
// token right after `import` is an identifier, `{`, or `type`, never a quote. So this
// pattern and `IMPORT_FROM_PATTERN` never both fire on the same `from`-style import.
//
// G-02: a deny-list of specific forbidden module names (as this file used to have) is
// bypassable by any non-relative specifier that simply isn't on the list - e.g.
// `require("child_process")` (no `node:` prefix), `import("fs/promises")`,
// `import("node:http")`, `import { Worker } from "node:worker_threads"`. The predicate
// below inverts this into an ALLOW-list instead: every non-relative specifier must be
// one of the modules `src/core/**` legitimately imports today (`node:path`, the two
// `ajv`/`ajv-formats` entry points), or it is a violation - regardless of which of the
// extraction form (`from`, bare `import "..."`, `import()`, `require()`/`createRequire`,
// `process.getBuiltinModule()` - S-11) reached it.
import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CORE_DIR = fileURLToPath(new URL(".", import.meta.url));

// The exhaustive set of non-relative specifiers `src/core/**` (excluding this test
// file itself, which is allowed to use `node:fs`/`node:path`/`node:url`/`node:test`/
// `node:assert` to inspect source text - see the module comment above) may import,
// require, or dynamically import. Anything else - any host-touching module
// (`node:child_process`, `node:fs`, `node:os`, `node:worker_threads`, bare `fs`, bare
// `child_process`, ...) as well as anything simply not on this list - is a violation.
const ALLOWED_NON_RELATIVE_SPECIFIERS = ["node:path", "ajv", "ajv/dist/2020.js", "ajv-formats"];

const IMPORT_FROM_PATTERN = /from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_PATTERN = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// H-02: bare side-effect import, e.g. `import "node:fs";` - no `from` clause, so
// IMPORT_FROM_PATTERN never sees it. `import` must be followed (optional whitespace)
// directly by the quote, which is what rules out double-counting `import x from "y"`:
// there, the character after `import` is `x`/`{`/`type`, never a quote.
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s*['"]([^'"]+)['"]/g;
// S-11: `process.getBuiltinModule("node:child_process")` (Node 22.3+) is yet another
// way to reach a host module that bypasses every pattern above - none of them
// recognize the `getBuiltinModule` call form at all. Its literal-string-argument
// specifier is extracted the same way `require`'s is, so it goes through the SAME
// allow-list check as every other specifier (an allow-listed module, e.g.
// `getBuiltinModule("node:path")`, is not flagged either - it is the module identity
// that matters, not which syntax reached it).
const GET_BUILTIN_MODULE_PATTERN = /getBuiltinModule\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CREATE_REQUIRE_PATTERN = /createRequire/;

function extractSpecifiers(contents: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [
    IMPORT_FROM_PATTERN,
    DYNAMIC_IMPORT_PATTERN,
    REQUIRE_PATTERN,
    SIDE_EFFECT_IMPORT_PATTERN,
    GET_BUILTIN_MODULE_PATTERN,
  ]) {
    for (const match of contents.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Returns a violation message for `specifier` (imported/required from a file that
 * lives in directory `fileDir`), or undefined if it is allowed.
 *
 * - A relative specifier is forbidden if resolving it against `fileDir` lands outside
 *   `CORE_DIR` - this is the mechanical form of "core may not import ../platform,
 *   ../../git, etc.", but expressed as "may not resolve outside src/core/" so it also
 *   catches any depth of `../` and any alias path, not just the specific literal
 *   prefixes this file used to hardcode.
 * - A non-relative specifier is forbidden unless it is exactly one of
 *   `ALLOWED_NON_RELATIVE_SPECIFIERS`, or a subpath of one of them (e.g.
 *   `ajv/dist/2020.js`). This is an allow-list, not a deny-list: an unrecognized
 *   host-touching module fails closed instead of silently passing through.
 */
function violationForSpecifier(specifier: string, fileDir: string): string | undefined {
  if (specifier.startsWith(".")) {
    const resolved = resolve(fileDir, specifier);
    const rel = relative(CORE_DIR, resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return `relative import/require "${specifier}" escapes src/core/`;
    }
    return undefined;
  }
  const allowed = ALLOWED_NON_RELATIVE_SPECIFIERS.some(
    (entry) => specifier === entry || specifier.startsWith(`${entry}/`),
  );
  if (!allowed) {
    return `imports "${specifier}", which is not on the core allow-list (${ALLOWED_NON_RELATIVE_SPECIFIERS.join(", ")})`;
  }
  return undefined;
}

/** Pure predicate: given file text and the directory it lives in, list every violation. */
export function findBoundaryViolations(contents: string, fileDir: string): string[] {
  const violations: string[] = [];
  for (const specifier of extractSpecifiers(contents)) {
    const violation = violationForSpecifier(specifier, fileDir);
    if (violation) violations.push(violation);
  }
  if (CREATE_REQUIRE_PATTERN.test(contents)) {
    violations.push("uses createRequire(), a dynamic escape hatch around static import analysis");
  }
  return violations;
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
    } else if (extname(entry.name) === ".ts" && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("core does not import host-specific or outer-layer modules (whole-file scan)", async () => {
  const files = await listSourceFiles(CORE_DIR);
  assert.ok(files.length > 0, "expected to find source files under src/core");

  const violations: string[] = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const violation of findBoundaryViolations(contents, dirname(file))) {
      violations.push(`${relative(CORE_DIR, file)}: ${violation}`);
    }
  }

  assert.deepEqual(violations, [], `core boundary violations found:\n${violations.join("\n")}`);
});

test("findBoundaryViolations detects every bypass form on synthetic snippets (self-test, not files)", () => {
  // A plausible location for a real core file, used to resolve relative specifiers
  // below exactly as the real scanner would.
  const fakeFileDir = join(CORE_DIR, "contracts");

  const cases: Array<{ label: string; code: string }> = [
    { label: "static default import of a forbidden module", code: `import fs from "node:fs";` },
    { label: "static named import of a forbidden module", code: `import { spawn } from "node:child_process";` },
    {
      label: "multi-line named import (from-line does not start with 'import')",
      code: `import {\n  readFileSync,\n  writeFileSync,\n} from "node:fs";`,
    },
    { label: "dynamic import()", code: `const os = await import("node:os");` },
    { label: "require()", code: `const cp = require("node:child_process");` },
    {
      label: "createRequire escape hatch",
      code: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nrequire("node:fs");`,
    },
    // G-02: these bypass forms were previously missed entirely because the old
    // deny-list simply did not name these specifiers.
    { label: "require() of a non-'node:'-prefixed forbidden module", code: `const cp = require("child_process");` },
    { label: "dynamic import() of a non-'node:'-prefixed forbidden module", code: `const fsp = await import("fs/promises");` },
    { label: "dynamic import() of a 'node:'-prefixed forbidden module not on any deny-list", code: `const http = await import("node:http");` },
    { label: "static named import of node:worker_threads", code: `import { Worker } from "node:worker_threads";` },
    { label: "bare (non-'node:'-prefixed) static default import of fs", code: `import fs from "fs";` },
    // H-02: bare side-effect imports have no `from` clause at all, so none of the
    // `from`/`import()`/`require()` patterns above would have caught them.
    { label: "bare side-effect import of a forbidden module", code: `import "node:fs";` },
    {
      label: "bare side-effect import escaping into ../../platform",
      code: `import "../../platform/index.ts";`,
    },
    // S-11: `process.getBuiltinModule` (Node 22.3+) is a distinct bypass form none
    // of the patterns above recognized at all.
    { label: "process.getBuiltinModule of a forbidden module", code: `const cp = process.getBuiltinModule("node:child_process");` },
    // fakeFileDir is CORE_DIR/contracts (one level under core, like the real
    // core/contracts/*.ts files), so escaping to a sibling of core (src/platform,
    // src/process, src/cli, src/git) takes "../../<sibling>", matching how deep the
    // real files that would attempt this actually are.
    { label: "relative import escaping into ../../platform", code: `import type { PlatformAdapter } from "../../platform/types.ts";` },
    { label: "relative import escaping into ../../process", code: `import { NodeProcessRunner } from "../../process/runner.ts";` },
    { label: "relative import escaping into ../../cli", code: `import { main } from "../../cli/main.ts";` },
    { label: "relative import escaping into ../../git", code: `import { GitClient } from "../../git/index.ts";` },
  ];

  for (const { label, code } of cases) {
    const violations = findBoundaryViolations(code, fakeFileDir);
    assert.ok(violations.length > 0, `expected bypass form "${label}" to be detected for code: ${code}`);
  }

  // Negative control: a legitimate intra-core relative import must NOT be flagged.
  const legitimate = `import { getValue } from "../config/value.ts";`;
  assert.deepEqual(
    findBoundaryViolations(legitimate, join(CORE_DIR, "contracts")),
    [],
    "an intra-core relative import must not be flagged",
  );

  // Negative control: every entry actually on the allow-list (and a subpath of one)
  // must NOT be flagged either - this folds in what used to be a separate
  // "core may import node:path and ajv" test, now redundant since the allow-list is
  // enforced by this same predicate in the whole-file scan above (G-02).
  for (const specifier of ["node:path", "ajv", "ajv/dist/2020.js", "ajv-formats"]) {
    assert.deepEqual(
      findBoundaryViolations(`import x from "${specifier}";`, fakeFileDir),
      [],
      `expected allow-listed specifier "${specifier}" not to be flagged`,
    );
  }

  // S-11: an allow-listed module reached via process.getBuiltinModule must not be
  // flagged either - it is the module identity that matters, not the syntax used.
  assert.deepEqual(
    findBoundaryViolations(`process.getBuiltinModule("node:path");`, fakeFileDir),
    [],
    "expected an allow-listed specifier reached via process.getBuiltinModule not to be flagged",
  );
});
