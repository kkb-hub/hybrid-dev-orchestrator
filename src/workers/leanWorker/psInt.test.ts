// Pins psInt's round-half-to-even behaviour (see psInt.ts's header comment for why plain
// truncation or JS's Math.round are both wrong substitutes for PowerShell's `[int]` cast).
// Nothing else in this suite exercises psInt directly - mutation testing confirmed that
// replacing its body with `Math.trunc` leaves the entire suite green - so this file is the
// sole thing pinning the behaviour that is the reason the module exists.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { psInt } from "./psInt.ts";
import { createSession, type WorkerSessionConfig } from "./session.ts";

// Oracle table verified against a real `pwsh` on this machine (`[int]$value` for each row).
// The current `psInt` reproduces every row.
//
// What each row rules out:
//  - The `.5` ties (669.5, 670.5, 201.5, 202.5, -0.5, -1.5, 2.5, 3.5, 0.5) are the cases
//    that distinguish round-half-to-even from BOTH Math.trunc (which would chop every one
//    of these toward zero) and Math.round (which rounds every positive .5 up and gets
//    negative .5 wrong, per the negative cases below).
//  - The non-tie cases (20643.84, 7454.72, 3727.5's non-tie cousin 1.4999, 2.5000001)
//    distinguish psInt from Math.trunc: truncation would give 20643, 7454, 1, and 2 -
//    all wrong.
//  - The negative ties (-0.5 -> 0, -1.5 -> -2) distinguish psInt from Math.round, which
//    gives -0 and -1 respectively (Math.round(-0.5) === -0, Math.round(-1.5) === -1) -
//    neither matches .NET's Convert.ToInt32 result.
const ORACLE_TABLE: Array<[value: number, expected: number]> = [
  [669.5, 670],
  [670.5, 670],
  [20643.84, 20644],
  [201.5, 202],
  [202.5, 202],
  [-0.5, 0],
  [-1.5, -2],
  [2.5, 2],
  [3.5, 4],
  [0.5, 0],
  [7454.72, 7455],
  [3727.5, 3728],
  [1.4999, 1],
  [2.5000001, 3],
];

test("psInt: reproduces PowerShell's [int] round-half-to-even cast against a real-pwsh oracle table", () => {
  for (const [value, expected] of ORACLE_TABLE) {
    assert.equal(psInt(value), expected, `psInt(${value}) should equal ${expected}`);
  }
});

function baseConfig(overrides: Partial<WorkerSessionConfig> = {}): WorkerSessionConfig {
  return {
    workspace: "C:/tmp/hdo-lean-worker-psint-test",
    readOnly: false,
    model: "qwen3.8:27b-q4_K_M",
    contextTokens: 32768,
    maxTurns: 40,
    maxToolResultChars: 4000,
    compactAtPercent: 65,
    keepRecentMessages: 6,
    requestTimeoutSeconds: 120,
    ollamaUri: "http://127.0.0.1:11434",
    tools: [],
    ...overrides,
  };
}

// The observable divergence at the oracle's own default configuration
// (`-ContextTokens 32768 -CompactAtPercent 65`): see session.ts's createSession for the
// `[int](...)` casts these values come from. Asserted through createSession (not just
// against psInt directly) so the wiring - not only the helper - is pinned.
test("createSession: maxBlockTokens and maxBlockHalfTokens use psInt's rounding, not truncation, at the oracle's default -ContextTokens 32768 -CompactAtPercent 65", () => {
  const session = createSession(baseConfig({ contextTokens: 32768, compactAtPercent: 65 }));

  // psInt(7454.72) = 7455; plain truncation would give 7454.
  assert.equal(session.maxBlockTokens, 7455);
  // psInt(3727.5) = 3728 (tie, rounds to the even neighbour); plain truncation would give 3727.
  assert.equal(session.maxBlockHalfTokens, 3728);
});
