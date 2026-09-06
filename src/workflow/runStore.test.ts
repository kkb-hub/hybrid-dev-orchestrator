// Tests for `RunStore`/`readRun` (State.ps1 port). Uses real temp directories
// (no fakes needed - `RunStore` only touches the filesystem through the shared
// `writeJsonFile` helper and a plain `appendFileSync`).
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunRecord } from "../core/workflow/runRecord.ts";
import { RunStore, readRun } from "./runStore.ts";

// The store only reads/writes `state`, `iteration` and `updatedAt`; the tests build
// minimal objects and widen them to `RunRecord` (the full shape is WP-A/WP-F2 territory).
function asRun(partial: { state: RunRecord["state"]; iteration: number; updatedAt: string }): RunRecord {
  return partial as unknown as RunRecord;
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hdo-runstore-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}

function readEventLines(artifactPath: string): unknown[] {
  const raw = readFileSync(join(artifactPath, "events.jsonl"), "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("save rewrites updatedAt and writes pretty JSON", () => {
  withTempDir((artifactPath) => {
    let tick = 0;
    const timestamps = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
    const store = new RunStore({ artifactPath, now: () => timestamps[tick++] });
    const run = asRun({ state: "CREATED", iteration: 0, updatedAt: "stale" });

    store.save(run);

    assert.equal(run.updatedAt, "2026-01-01T00:00:00.000Z");
    const raw = readFileSync(join(artifactPath, "run.json"), "utf8");
    assert.match(raw, /\n  "state": "CREATED"/); // pretty (indented), not a single compact line
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed, { state: "CREATED", iteration: 0, updatedAt: "2026-01-01T00:00:00.000Z" });

    store.save(run);
    assert.equal(run.updatedAt, "2026-01-02T00:00:00.000Z");
  });
});

test("addEvent appends one line per call with 'at' as the last key", () => {
  withTempDir((artifactPath) => {
    const store = new RunStore({ artifactPath, now: () => "2026-01-01T00:00:00.000Z" });

    store.addEvent({ type: "run.created", runId: "run-1" });
    store.addEvent({ type: "run.created", runId: "run-2" });

    const raw = readFileSync(join(artifactPath, "events.jsonl"), "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const keys = Object.keys(JSON.parse(line));
      assert.equal(keys.at(-1), "at");
    }
    const events = readEventLines(artifactPath);
    assert.deepEqual(events[0], { type: "run.created", runId: "run-1", at: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(events[1], { type: "run.created", runId: "run-2", at: "2026-01-01T00:00:00.000Z" });
  });
});

test("addEvent redacts a secret embedded in a field's value, in the file", () => {
  withTempDir((artifactPath) => {
    const store = new RunStore({ artifactPath, now: () => "2026-01-01T00:00:00.000Z" });

    store.addEvent({ type: "github.status.failed", labelKey: "x", message: "request failed: password=abc123 rejected" });

    const raw = readFileSync(join(artifactPath, "events.jsonl"), "utf8");
    assert.ok(!raw.includes("abc123"), "raw secret must not appear in the file");
    assert.ok(raw.includes("password=[REDACTED]"), "redaction marker must appear in place of the secret");
    const [event] = readEventLines(artifactPath) as Array<{ message: string }>;
    assert.equal(event.message, "request failed: password=[REDACTED] rejected");
  });
});

test("setState: legal chain CREATED->ISSUE_SELECTED->PREFLIGHT writes 3 lines with iteration at transition time", () => {
  withTempDir((artifactPath) => {
    const store = new RunStore({ artifactPath, now: () => "2026-01-01T00:00:00.000Z" });
    const run = asRun({ state: "CREATED", iteration: 0, updatedAt: "" });

    store.setState(run, "ISSUE_SELECTED", "GitHub Issue resolved and contract validated.");
    run.iteration = 5; // simulate a later change of iteration before the next transition
    store.setState(run, "PREFLIGHT", "Checking selected adapters and local environment.");
    store.setState(run, "ISSUE_CLAIMED", "GitHub claim marker won the best-effort lock.");

    assert.equal(run.state, "ISSUE_CLAIMED");
    const events = readEventLines(artifactPath) as Array<Record<string, unknown>>;
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], {
      type: "state.transition",
      from: "CREATED",
      to: "ISSUE_SELECTED",
      reason: "GitHub Issue resolved and contract validated.",
      iteration: 0,
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(events[1], {
      type: "state.transition",
      from: "ISSUE_SELECTED",
      to: "PREFLIGHT",
      reason: "Checking selected adapters and local environment.",
      iteration: 5,
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(events[2]?.to, "ISSUE_CLAIMED");
    const savedRun = JSON.parse(readFileSync(join(artifactPath, "run.json"), "utf8"));
    assert.equal(savedRun.state, "ISSUE_CLAIMED");
  });
});

test("setState: illegal CREATED -> APPROVED throws the PS text and writes nothing", () => {
  withTempDir((artifactPath) => {
    const store = new RunStore({ artifactPath, now: () => "2026-01-01T00:00:00.000Z" });
    const run = asRun({ state: "CREATED", iteration: 0, updatedAt: "" });

    assert.throws(() => store.setState(run, "APPROVED", "irrelevant"), {
      message: "Invalid HDO state transition: CREATED -> APPROVED",
    });

    assert.equal(run.state, "CREATED", "run object must not be mutated on an illegal transition");
    assert.throws(() => readFileSync(join(artifactPath, "events.jsonl"), "utf8"));
    assert.throws(() => readFileSync(join(artifactPath, "run.json"), "utf8"));
  });
});

test("readRun throws 'JSON file was not found' for a missing run", () => {
  withTempDir((artifactRoot) => {
    assert.throws(() => readRun(artifactRoot, "issue-7-20260101T000000Z-deadbeef"), {
      message: new RegExp(`^JSON file was not found: .*issue-7-20260101T000000Z-deadbeef.*run\\.json$`),
    });
  });
});

test("readRun round-trips a run.json written by RunStore.save", () => {
  withTempDir((artifactRoot) => {
    const runId = "issue-7-20260101T000000Z-deadbeef";
    const artifactPath = join(artifactRoot, runId);
    const store = new RunStore({ artifactPath, now: () => "2026-01-01T00:00:00.000Z" });
    store.save(asRun({ state: "CREATED", iteration: 0, updatedAt: "" }));

    const run = readRun(artifactRoot, runId);
    assert.equal(run.state, "CREATED");
    assert.equal(run.updatedAt, "2026-01-01T00:00:00.000Z");
  });
});

test("readRun throws 'Invalid JSON' for a malformed run.json", () => {
  withTempDir((artifactRoot) => {
    const runId = "run-1";
    const dir = join(artifactRoot, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), "{not json", "utf8");

    assert.throws(() => readRun(artifactRoot, runId), { message: /^Invalid JSON in '.*run\.json': / });
  });
});
