// Pure Markdown/Issue-Form normalization helpers, ported from GitHub.ps1's
// `Get-HdoMarkdownSections` (GitHub.ps1:180-214), `Get-HdoMarkdownList`
// (GitHub.ps1:216-230), `Get-HdoMarkdownScalar` (GitHub.ps1:232-239) and
// `Get-HdoDependencyReferences` (GitHub.ps1:241-255). No I/O; safe to unit test in
// isolation.
import type { IssueDependency } from "../core/contracts/types.ts";

const HEADING_PATTERN = /^#{2,4}[ \t]+(?<title>.+?)[ \t]*$/gm;

/**
 * Ordered top-to-bottom exactly like the PowerShell `switch -Regex` (GitHub.ps1:194-
 * 210): the first pattern that matches wins. The real file's `switch` also contains a
 * SECOND, unreachable 'in scope' case (`'^(in scope|対象範囲|対象)$'`) between
 * `acceptanceCriteria` and `validationGates` - it is a strict subset of the `scope`
 * case already above it, and PowerShell's `switch` with `break` always matches the
 * first case that applies, so that second case can never fire. It is a documented
 * dead branch in the oracle, not a parity gap; this port omits it rather than
 * reproducing dead code.
 */
const SECTION_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(goal|目的|ゴール)$/, "goal"],
  [/^(problem|context|problem context|背景|課題|背景 課題)$/, "context"],
  [/^(out of scope|non goals?|対象外|非対象)$/, "outOfScope"],
  [/^(in scope|scope|対象範囲|スコープ)$/, "scope"],
  [/^(acceptance criteria|完了条件|受入条件|受け入れ条件)$/, "acceptanceCriteria"],
  [/^(validation gate ids?|validation gates?|validation|検証ゲート|検証)$/, "validationGates"],
  [
    /^(constraints?(?: and security(?: considerations?)?| security considerations?)?|security considerations?|制約|制約 セキュリティ|セキュリティ)$/,
    "constraints",
  ],
  [/^(dependencies|dependency|依存関係|依存)$/, "dependencies"],
  [/^(risk|リスク)$/, "risk"],
  [/^(priority|優先度)$/, "priority"],
  [/^(route hint|preferred execution|execution|実行方式|実行プロファイル)$/, "preferredExecution"],
  [/^(affected areas|影響範囲)$/, "affectedAreas"],
  [/^(additional context|追加情報)$/, "additionalContext"],
];

function normalizeHeadingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_:\-–—/\\()（）]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSectionKey(normalizedTitle: string): string | null {
  for (const [pattern, key] of SECTION_KEY_PATTERNS) {
    if (pattern.test(normalizedTitle)) return key;
  }
  return null;
}

/**
 * Splits an Issue body into `{ sectionKey: trimmedContent }` by `##`-`####` headings,
 * matching only the headings whose (normalized) title resolves to a known section key.
 * Mirrors `Get-HdoMarkdownSections` (GitHub.ps1:180-214).
 */
export function getMarkdownSections(body: string | null | undefined): Record<string, string> {
  const sections: Record<string, string> = {};
  if (!body) return sections;
  const headingMatches = [...body.matchAll(HEADING_PATTERN)];
  for (let index = 0; index < headingMatches.length; index++) {
    const match = headingMatches[index];
    const title = (match.groups?.title ?? "").trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < headingMatches.length ? (headingMatches[index + 1].index ?? body.length) : body.length;
    const content = body.slice(start, end).trim();
    const key = resolveSectionKey(normalizeHeadingTitle(title));
    if (key) sections[key] = content;
  }
  return sections;
}

// `i` flags below mirror PowerShell `-match`/`-notmatch`, which are case-insensitive
// by default (GitHub.ps1:219,227,237) - a bare "no response"/"NO RESPONSE" sentinel
// must normalize the same as "No response".
const LIST_SENTINEL_PATTERN = /^\s*(?:_?No response_?|なし|N\/A)\s*$/i;
const BULLET_LINE_PATTERN = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(?<value>.+?)\s*$/;
const FALLBACK_LINE_SENTINEL_PATTERN = /^_?No response_?$/i;

/**
 * Extracts list items from a Markdown section body: `-`/`*`/`+` bullets (with an
 * optional `[ ]`/`[x]` checkbox prefix stripped), falling back to newline-split plain
 * lines when no bullet syntax is present. GitHub Issue Forms' `_No response_`
 * sentinel (and the ja-JP `なし`/`N/A` variants) normalize to an empty list either way.
 * Mirrors `Get-HdoMarkdownList` (GitHub.ps1:216-230).
 */
export function getMarkdownList(text: string | null | undefined): string[] {
  if (!text || LIST_SENTINEL_PATTERN.test(text)) return [];
  const items: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(BULLET_LINE_PATTERN);
    if (match?.groups?.value) items.push(match.groups.value.trim());
  }
  if (items.length === 0 && text.trim()) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !FALLBACK_LINE_SENTINEL_PATTERN.test(line));
  }
  return items;
}

const SCALAR_SENTINEL_PATTERN = /^(?:_?No response_?|なし|N\/?A)$/i;

/** Trims a scalar Markdown section body, normalizing the `_No response_`/`なし`/`N/A`/`NA` sentinels to `""`. Mirrors `Get-HdoMarkdownScalar` (GitHub.ps1:232-239). */
export function getMarkdownScalar(text: string | null | undefined): string {
  if (!text) return "";
  const value = text.trim();
  if (SCALAR_SENTINEL_PATTERN.test(value)) return "";
  return value;
}

const DEPENDENCY_PATTERN = /(?<![A-Za-z0-9_.-])(?:(?<repo>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(?<number>[1-9][0-9]*)/g;

/**
 * Extracts `#123` / `owner/repo#123` references from free text, defaulting the
 * repository to `defaultRepository` when omitted, then sorts by (repository, number)
 * and drops adjacent duplicates after sorting - the exact semantics of PowerShell's
 * `Sort-Object repository, number -Unique`. Mirrors `Get-HdoDependencyReferences`
 * (GitHub.ps1:241-255). The sort/dedup key folds `repository` to lowercase (matching
 * PowerShell's default case-insensitive string comparison - see the identical
 * rationale documented in `src/core/config/validate.ts`), so `Acme/repo#5` and
 * `acme/repo#5` collapse into one entry; the surviving entry keeps whichever casing
 * sorted first.
 */
export function getDependencyReferences(text: string | null | undefined, defaultRepository: string): IssueDependency[] {
  if (!text) return [];
  const references: IssueDependency[] = [];
  for (const match of text.matchAll(DEPENDENCY_PATTERN)) {
    const repository = match.groups?.repo ? match.groups.repo : defaultRepository;
    const number = Number(match.groups?.number);
    references.push({ repository, number });
  }
  const sorted = references.slice().sort((a, b) => {
    const repositoryA = a.repository.toLowerCase();
    const repositoryB = b.repository.toLowerCase();
    if (repositoryA !== repositoryB) return repositoryA < repositoryB ? -1 : 1;
    return a.number - b.number;
  });
  const unique: IssueDependency[] = [];
  for (const reference of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last.repository.toLowerCase() !== reference.repository.toLowerCase() || last.number !== reference.number) {
      unique.push(reference);
    }
  }
  return unique;
}
