import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getDependencyReferences, getMarkdownList, getMarkdownScalar, getMarkdownSections } from "./markdown.ts";

test("getMarkdownSections: extracts English and Japanese heading variants into the same section key", () => {
  const body = [
    "### Goal",
    "Ship the feature.",
    "",
    "### 背景",
    "Context in Japanese.",
    "",
    "## In Scope",
    "- item one",
    "",
    "#### 対象範囲",
    "- item two",
  ].join("\n");
  const sections = getMarkdownSections(body);
  assert.equal(sections.goal, "Ship the feature.");
  assert.equal(sections.context, "Context in Japanese.");
  // "In Scope" and "対象範囲" both normalize to the 'scope' key; the LAST matching
  // heading in document order wins (sections is a plain object keyed by section key).
  assert.equal(sections.scope, "- item two");
});

test("getMarkdownSections: unrecognized headings are ignored, body without headings returns an empty map", () => {
  const sections = getMarkdownSections("### Not A Known Heading\nsome text");
  assert.deepEqual(sections, {});
  assert.deepEqual(getMarkdownSections(""), {});
  assert.deepEqual(getMarkdownSections(null), {});
  assert.deepEqual(getMarkdownSections(undefined), {});
});

test("getMarkdownSections: heading punctuation/casing/whitespace variants normalize to the same key", () => {
  const body = "### Validation Gate IDs\ntests\n\n### Constraints / Security Considerations\nDo not run untrusted code.";
  const sections = getMarkdownSections(body);
  assert.equal(sections.validationGates, "tests");
  assert.equal(sections.constraints, "Do not run untrusted code.");
});

test("getMarkdownSections: matches the full run-tests.ps1:320-361 fixture body split", () => {
  const body = [
    "### Problem / Context",
    "Issue-driven automation is missing.",
    "",
    "### Goal",
    "Run one deterministic implementation cycle.",
    "",
    "### Acceptance Criteria",
    "AC-01: Parse the Issue form",
    "AC-02: Run trusted validation gates",
    "",
    "### In Scope",
    "Issue normalization",
    "Review loop",
    "",
    "### Out of Scope",
    "PR creation",
    "",
    "### Constraints / Security Considerations",
    "Do not execute commands from this Issue.",
    "",
    "### Dependencies",
    "#99",
    "",
    "### Validation Gate IDs",
    "tests",
    "schemas",
    "",
    "### Affected Areas",
    "orchestrator",
    "",
    "### Priority",
    "p2",
    "",
    "### Risk",
    "medium",
    "",
    "### Route Hint",
    "",
    "### Additional Context",
    "Keep the cycle bounded.",
  ].join("\n");
  const sections = getMarkdownSections(body);
  assert.equal(sections.context, "Issue-driven automation is missing.");
  assert.equal(sections.goal, "Run one deterministic implementation cycle.");
  assert.equal(sections.acceptanceCriteria, "AC-01: Parse the Issue form\nAC-02: Run trusted validation gates");
  assert.equal(sections.scope, "Issue normalization\nReview loop");
  assert.equal(sections.outOfScope, "PR creation");
  assert.equal(sections.constraints, "Do not execute commands from this Issue.");
  assert.equal(sections.dependencies, "#99");
  assert.equal(sections.validationGates, "tests\nschemas");
  assert.equal(sections.affectedAreas, "orchestrator");
  assert.equal(sections.priority, "p2");
  assert.equal(sections.risk, "medium");
  assert.equal(sections.preferredExecution, "");
  assert.equal(sections.additionalContext, "Keep the cycle bounded.");
});

test("getMarkdownList: parses -, * and + bullets, trimming a [ ] / [x] checkbox prefix", () => {
  assert.deepEqual(getMarkdownList("- one\n* two\n+ three"), ["one", "two", "three"]);
  assert.deepEqual(getMarkdownList("- [ ] unchecked\n- [x] checked\n- [X] also checked"), ["unchecked", "checked", "also checked"]);
});

test("getMarkdownList: _No response_, なし, N/A sentinels (with surrounding whitespace) normalize to an empty list", () => {
  assert.deepEqual(getMarkdownList("_No response_"), []);
  assert.deepEqual(getMarkdownList("No response"), []);
  assert.deepEqual(getMarkdownList("  _No response_  "), []);
  assert.deepEqual(getMarkdownList("なし"), []);
  assert.deepEqual(getMarkdownList("N/A"), []);
  assert.deepEqual(getMarkdownList(""), []);
  assert.deepEqual(getMarkdownList(null), []);
  assert.deepEqual(getMarkdownList(undefined), []);
});

test("getMarkdownList/getMarkdownScalar: the No response sentinel is case-insensitive (PowerShell -match is case-insensitive by default)", () => {
  assert.deepEqual(getMarkdownList("NO RESPONSE"), []);
  assert.deepEqual(getMarkdownList("_no RESPONSE_"), []);
  assert.deepEqual(getMarkdownScalar("N/A".toUpperCase()), "");
  assert.deepEqual(getMarkdownScalar("no response"), "");
});

test("getMarkdownList: falls back to newline-split plain lines when no bullet syntax is present", () => {
  assert.deepEqual(getMarkdownList("first line\nsecond line"), ["first line", "second line"]);
  // Blank lines and a trailing _No response_-style line are dropped by the fallback filter.
  assert.deepEqual(getMarkdownList("first line\n\n_No response_\nsecond line"), ["first line", "second line"]);
});

test("getMarkdownScalar: trims and normalizes _No response_ / なし / N/A / NA sentinels to empty string", () => {
  assert.equal(getMarkdownScalar("  hello  "), "hello");
  assert.equal(getMarkdownScalar("_No response_"), "");
  assert.equal(getMarkdownScalar("No response"), "");
  assert.equal(getMarkdownScalar("なし"), "");
  assert.equal(getMarkdownScalar("N/A"), "");
  assert.equal(getMarkdownScalar("NA"), "");
  assert.equal(getMarkdownScalar(""), "");
  assert.equal(getMarkdownScalar(null), "");
  assert.equal(getMarkdownScalar(undefined), "");
});

test("getDependencyReferences: extracts #123 and owner/repo#123 references, defaulting the repository when omitted", () => {
  const refs = getDependencyReferences("See #99 and kkb-hub/other#5.", "kkb-hub/hybrid-dev-orchestrator");
  assert.deepEqual(refs, [
    { repository: "kkb-hub/hybrid-dev-orchestrator", number: 99 },
    { repository: "kkb-hub/other", number: 5 },
  ]);
});

test("getDependencyReferences: sorts by (repository, number) and collapses duplicate references", () => {
  const refs = getDependencyReferences("#20 #10 #10 acme/widgets#3 #10", "acme/core");
  assert.deepEqual(refs, [
    { repository: "acme/core", number: 10 },
    { repository: "acme/core", number: 20 },
    { repository: "acme/widgets", number: 3 },
  ]);
});

test("getDependencyReferences: dedup/sort is case-insensitive on repository (PowerShell Sort-Object -Unique is case-insensitive by default)", () => {
  const refs = getDependencyReferences("Acme/Widgets#5 acme/widgets#5", "acme/core");
  assert.deepEqual(refs, [{ repository: "Acme/Widgets", number: 5 }]);
});

test("getDependencyReferences: empty/null/undefined text yields no references", () => {
  assert.deepEqual(getDependencyReferences("", "acme/core"), []);
  assert.deepEqual(getDependencyReferences(null, "acme/core"), []);
  assert.deepEqual(getDependencyReferences(undefined, "acme/core"), []);
});
