import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveExitCode } from "./types.ts";

const BASE = { timedOut: false, outputLimitExceeded: false, inputError: "", captureError: "", realExitCode: 0 };

test("resolveExitCode returns the real exit code when nothing failed", () => {
  assert.equal(resolveExitCode({ ...BASE, realExitCode: 7 }), 7);
});

test("resolveExitCode returns -1 when the process never reported an exit code", () => {
  assert.equal(resolveExitCode({ ...BASE, realExitCode: null }), -1);
});

test("resolveExitCode: timedOut wins over everything else (124)", () => {
  assert.equal(
    resolveExitCode({ timedOut: true, outputLimitExceeded: true, inputError: "x", captureError: "y", realExitCode: 3 }),
    124,
  );
});

test("resolveExitCode: outputLimitExceeded wins over inputError/captureError/realExitCode (125)", () => {
  assert.equal(
    resolveExitCode({ timedOut: false, outputLimitExceeded: true, inputError: "x", captureError: "y", realExitCode: 3 }),
    125,
  );
});

test("resolveExitCode: inputError wins over captureError/realExitCode (126)", () => {
  assert.equal(
    resolveExitCode({ timedOut: false, outputLimitExceeded: false, inputError: "x", captureError: "y", realExitCode: 3 }),
    126,
  );
});

test("resolveExitCode: captureError wins over realExitCode (127)", () => {
  assert.equal(resolveExitCode({ ...BASE, captureError: "boom", realExitCode: 3 }), 127);
});

test("resolveExitCode: a timeout that raced ahead of a stdin EPIPE still yields 124, not 126", () => {
  // Mirrors tests/fixtures/runtime/ignore-input.ps1: PowerShell's WaitForInputErrorAsync
  // can independently record a non-empty InputError even when the timeout task won the
  // race, but the exit-code precedence chain still resolves to 124.
  assert.equal(resolveExitCode({ timedOut: true, outputLimitExceeded: false, inputError: "epipe", captureError: "", realExitCode: null }), 124);
});
