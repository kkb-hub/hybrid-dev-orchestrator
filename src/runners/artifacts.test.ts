import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { protectLogFile, readBoundedTextFile, writeJsonFile, writeTextFile } from "./artifacts.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "hdo-artifacts-test-"));
}

// --- readBoundedTextFile ---------------------------------------------------------

test("readBoundedTextFile throws 'File was not found' for a missing path", () => {
  const dir = makeTempDir();
  try {
    const missing = join(dir, "nope.txt");
    assert.throws(() => readBoundedTextFile(missing), new RegExp(`File was not found: .*nope\\.txt`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTextFile throws 'File was not found' for a directory (Test-Path -PathType Leaf semantics)", () => {
  const dir = makeTempDir();
  try {
    const subdir = join(dir, "a-directory.txt");
    mkdirSync(subdir);
    assert.throws(() => readBoundedTextFile(subdir), new RegExp(`File was not found: .*a-directory\\.txt`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTextFile throws 'File exceeds the HDO output limit' when the file is larger than maximumBytes", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "big.txt");
    writeFileSync(path, "x".repeat(2048), "utf8");
    assert.throws(
      () => readBoundedTextFile(path, 1024),
      new RegExp(`File exceeds the HDO output limit of 1024 bytes: .*big\\.txt`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTextFile reads UTF-8 content within the limit", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "ok.txt");
    writeFileSync(path, "hello, world", "utf8");
    assert.equal(readBoundedTextFile(path), "hello, world");
    assert.equal(readBoundedTextFile(path, 1024), "hello, world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBoundedTextFile strips a leading UTF-8 BOM like [IO.File]::ReadAllText does", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "bom.txt");
    writeFileSync(path, "﻿hello", "utf8");
    assert.equal(readBoundedTextFile(path), "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- writeJsonFile -----------------------------------------------------------------

test("writeJsonFile writes pretty-printed JSON and leaves no .tmp file behind", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "out.json");
    writeJsonFile(path, { b: 2, a: [1, 2, 3], c: null });
    const raw = readFileSync(path, "utf8");
    assert.equal(raw, `${JSON.stringify({ b: 2, a: [1, 2, 3], c: null }, null, 2)}\n`);
    assert.deepEqual(JSON.parse(raw), { b: 2, a: [1, 2, 3], c: null });
    const leftovers = readdirSync(dir).filter((name) => name !== "out.json");
    assert.deepEqual(leftovers, [], `expected no leftover temp files, found: ${leftovers.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonFile creates the parent directory if it does not exist", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "nested", "deeper", "out.json");
    writeJsonFile(path, { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonFile accepts a JSON null value (AllowNull parity with Write-HdoJsonFile)", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "null.json");
    writeJsonFile(path, null);
    assert.equal(readFileSync(path, "utf8"), "null\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonFile atomically replaces an existing file (no observable half-written state)", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "replace.json");
    writeJsonFile(path, { version: 1 });
    writeJsonFile(path, { version: 2 });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 2 });
    const leftovers = readdirSync(dir).filter((name) => name !== "replace.json");
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- writeTextFile -------------------------------------------------------------------

test("writeTextFile writes exact UTF-8 text with no BOM", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "prompt.md");
    writeTextFile(path, "line one\nline two\n");
    const buffer = readFileSync(path);
    assert.equal(buffer.toString("utf8"), "line one\nline two\n");
    assert.notEqual(buffer[0], 0xef, "expected no UTF-8 BOM byte sequence at the start of the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- protectLogFile ------------------------------------------------------------------

test("protectLogFile is a no-op when the file does not exist", () => {
  const dir = makeTempDir();
  try {
    const missing = join(dir, "missing.log");
    assert.doesNotThrow(() => protectLogFile(missing));
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protectLogFile redacts 'password=secret-value' in place", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "run.log");
    writeFileSync(path, "starting step\npassword=secret-value\ndone\n", "utf8");
    protectLogFile(path);
    const redacted = readFileSync(path, "utf8");
    assert.ok(redacted.includes("password=[REDACTED]"), `expected redaction, got: ${redacted}`);
    assert.ok(!redacted.includes("secret-value"), `secret leaked, got: ${redacted}`);
    const leftovers = readdirSync(dir).filter((name) => name !== "run.log");
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protectLogFile truncates to the byte cap without producing a lone surrogate", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "surrogate.log");
    // The initial bounded read (Read-HdoBoundedTextFile parity) applies the SAME
    // `maximumBytes` cap to the ORIGINAL file, so truncation can only be exercised
    // when redaction ITSELF grows the text past that cap (`token=x` -> 7 bytes
    // becomes `token=[REDACTED]` -> 16 bytes, a net +9 byte growth) - not by writing
    // an already-oversized file (that would just throw "File exceeds the HDO output
    // limit", the same as `readBoundedTextFile`). A trailing space keeps the greedy
    // secret-value pattern (`[^\s,}]+`) from swallowing the emoji that follows it
    // into the redaction match.
    //
    // raw = "aaaaaaaaaa" + "token=x" + " " + <U+1F600 emoji> = 22 UTF-8 bytes.
    // redacted = "aaaaaaaaaa" + "token=[REDACTED]" + " " + <emoji> = 31 UTF-8 bytes /
    // 29 UTF-16 code units. With maximumBytes=30 (>= the 22-byte original, so the
    // initial read succeeds; < the 31-byte redacted text, so truncation is
    // required), the byte-budget shrink loop lands on characterCount=28 - i.e.
    // `redacted.slice(0,28)`, which ends in a LONE high surrogate (the low surrogate
    // at index 28 is excluded) - before the surrogate-safety backoff drops that
    // dangling high surrogate too, landing on characterCount=27 instead. Verified by
    // direct calculation (see the ollamaContextModel/artifacts implementation notes);
    // this test only asserts the OBSERVABLE safety property, not the exact
    // intermediate step.
    const raw = "a".repeat(10) + "token=x" + " " + String.fromCharCode(0xd83d, 0xde00);
    assert.equal(Buffer.byteLength(raw, "utf8"), 22);
    writeFileSync(path, raw, "utf8");

    protectLogFile(path, 30);

    const result = readFileSync(path, "utf8");
    assert.ok(Buffer.byteLength(result, "utf8") <= 30, `expected result within the 30-byte cap, got ${Buffer.byteLength(result, "utf8")} bytes`);
    assert.equal(result, "aaaaaaaaaatoken=[REDACTED] ", "expected the dangling high surrogate to be dropped, not kept lone");
    // No lone surrogate anywhere in the result (a paired surrogate would show up as a
    // low surrogate immediately following a high surrogate; here there should be none
    // at all - the whole emoji was dropped).
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      assert.ok(code < 0xd800 || code > 0xdfff, `unexpected lone surrogate at index ${i} in result`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protectLogFile leaves content under the cap unchanged apart from redaction", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "small.log");
    writeFileSync(path, "hello, world\n", "utf8");
    protectLogFile(path, 1024);
    assert.equal(readFileSync(path, "utf8"), "hello, world\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
