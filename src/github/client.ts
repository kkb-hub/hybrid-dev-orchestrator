// GhClient: a thin, typed wrapper over `gh` (GitHub CLI), running every invocation
// through a `ProcessRunner` (never a shell string) - mirrors `GitClient` (git/index.ts)
// and the underlying `Invoke-HdoGh`/`Invoke-HdoGhJson`/`Invoke-HdoGhPagedJson`
// (GitHub.ps1:1-50).
//
// This file is first in the `src/github/**` dependency order (client.ts ->
// markdown.ts -> normalize.ts -> contractValidation.ts -> authorization.ts ->
// claim.ts -> issues.ts -> labels.ts; each file only imports from files before it in
// this list). `getIssue` and `resolveRepositorySlug` live here rather than in
// issues.ts specifically to break a circular dependency: `claim.ts` needs `getIssue`,
// and `issues.ts` needs `claim.ts`'s `getClaimComments` - so `getIssue` cannot live
// downstream of `claim.ts` without creating a cycle.
import type { ProcessRunner } from "../core/process/types.ts";
import type { GithubIssue, JsonValue, ResolvedHdoConfig } from "../core/contracts/types.ts";
import { formatProcessFailure, GitClient } from "../git/index.ts";

export interface GhCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GhClientOptions {
  runner: ProcessRunner;
  ghExecutable?: string;
  /** Seconds. Default 120, matching `Invoke-HdoGh -TimeoutSeconds` (GitHub.ps1:5). */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 120;

export class GhClient {
  private readonly runner: ProcessRunner;
  private readonly ghExecutable: string;
  private readonly timeoutSeconds: number;

  constructor(options: GhClientOptions) {
    this.runner = options.runner;
    this.ghExecutable = options.ghExecutable ?? "gh";
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  /**
   * Runs `gh <args>` in `cwd` and always resolves (never rejects) with the exit code
   * and captured output. Mirrors `Invoke-HdoGh` (GitHub.ps1:1-11) and `GitClient.exec`'s
   * "callers inspect exitCode" contract.
   */
  async exec(args: string[], cwd: string, timeoutSeconds: number = this.timeoutSeconds): Promise<GhCommandResult> {
    const result = await this.runner.run({
      command: this.ghExecutable,
      arguments: args,
      workingDirectory: cwd,
      timeoutSeconds,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * `gh <args>`, parsed as JSON. Throws `GitHub CLI failed: <stderr>` on non-zero exit
   * and `GitHub CLI returned invalid JSON: <message>` on a parse failure - exact text
   * from `Invoke-HdoGhJson` (GitHub.ps1:13-30).
   */
  async execJson<T = JsonValue>(args: string[], cwd: string, timeoutSeconds: number = this.timeoutSeconds): Promise<T> {
    const result = await this.exec(args, cwd, timeoutSeconds);
    if (result.exitCode !== 0) {
      throw new Error(`GitHub CLI failed: ${result.stderr.trim()}`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`GitHub CLI returned invalid JSON: ${(error as Error).message}`);
    }
  }

  /**
   * `gh <args>`, throwing on non-zero exit. Mirrors `Invoke-HdoGh -ThrowOnError`
   * (GitHub.ps1:6-10), whose throw text comes from `Invoke-HdoProcess`'s OWN generic
   * `-ThrowOnError` formatter (`formatProcessFailure`) - a DIFFERENT message shape
   * from `execJson`'s "GitHub CLI failed: ..." (that text is `Invoke-HdoGhJson`'s own
   * explicit throw, unrelated to `-ThrowOnError`). Always uses the literal command
   * name `'gh'` in the message regardless of `ghExecutable`, matching
   * `Invoke-HdoGh` always passing the literal `'gh'` to `Invoke-HdoProcess`  (the same
   * precedent as `GitClient.repositoryRoot` using the literal `'git'`).
   */
  async execThrowing(args: string[], cwd: string, timeoutSeconds: number = this.timeoutSeconds): Promise<GhCommandResult> {
    const result = await this.exec(args, cwd, timeoutSeconds);
    if (result.exitCode !== 0) {
      throw new Error(formatProcessFailure("gh", result.exitCode, result.stdout, result.stderr));
    }
    return result;
  }

  /**
   * `gh api --paginate --slurp -X GET <endpoint> -f per_page=100`, flattened. Mirrors
   * `Invoke-HdoGhPagedJson` (GitHub.ps1:32-50): `--slurp` returns an array of pages,
   * each itself an array of items; this method concatenates every page's items into a
   * single flat array, in page order. Throws `GitHub CLI failed: <stderr>` on non-zero
   * exit and `GitHub CLI returned invalid paginated JSON: <message>` on a parse
   * failure.
   */
  async execPagedJson<T = JsonValue>(endpoint: string, cwd: string, timeoutSeconds: number = this.timeoutSeconds): Promise<T[]> {
    const result = await this.exec(["api", "--paginate", "--slurp", "-X", "GET", endpoint, "-f", "per_page=100"], cwd, timeoutSeconds);
    if (result.exitCode !== 0) {
      throw new Error(`GitHub CLI failed: ${result.stderr.trim()}`);
    }
    let pages: unknown;
    try {
      pages = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`GitHub CLI returned invalid paginated JSON: ${(error as Error).message}`);
    }
    const items: T[] = [];
    for (const page of Array.isArray(pages) ? pages : [pages]) {
      for (const item of Array.isArray(page) ? page : [page]) {
        items.push(item as T);
      }
    }
    return items;
  }
}

/**
 * Handles both `["a","b"]` and `[{name:"a"},{name:"b"}]` label shapes returned by
 * different `gh` JSON selections. Mirrors `Get-HdoLabelNames` (GitHub.ps1:65-74).
 */
export function getLabelNames(labels: JsonValue | undefined): string[] {
  const items: JsonValue[] = labels === undefined || labels === null ? [] : Array.isArray(labels) ? labels : [labels];
  const names: string[] = [];
  for (const label of items) {
    if (typeof label === "string") {
      names.push(label);
    } else if (label !== null && typeof label === "object" && !Array.isArray(label) && "name" in label) {
      names.push(String((label as { name: JsonValue }).name));
    }
  }
  return names;
}

/**
 * Port of `Resolve-HdoRepositorySlug` (GitHub.ps1:52-63): prefers `github.repository`
 * from configuration, else parses `owner/repo` out of `git config --get
 * remote.origin.url`. The PowerShell original runs `Invoke-HdoGit ... -ThrowOnError`;
 * `GitClient.exec` itself never throws, so this reproduces `-ThrowOnError`'s behavior
 * (checking `exitCode` and throwing `formatProcessFailure("git", ...)`) at the call
 * site instead.
 */
export async function resolveRepositorySlug(config: Pick<ResolvedHdoConfig, "github" | "repositoryPath">, git: GitClient): Promise<string> {
  const configured = config.github?.repository;
  if (configured) return configured;
  const remote = await git.exec(["config", "--get", "remote.origin.url"], config.repositoryPath ?? "");
  if (remote.exitCode !== 0) {
    throw new Error(formatProcessFailure("git", remote.exitCode, remote.stdout, remote.stderr));
  }
  const url = remote.stdout.trim();
  const match = url.match(/github\.com[/:](?<slug>[^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  if (match?.groups?.slug) return match.groups.slug;
  throw new Error("Unable to resolve GitHub owner/repository. Set github.repository in configuration.");
}

/** Port of `Get-HdoIssue` (GitHub.ps1:76-90). */
export async function getIssue(
  gh: GhClient,
  git: GitClient,
  config: Pick<ResolvedHdoConfig, "github" | "repositoryPath">,
  number: number,
  repository?: string,
): Promise<GithubIssue> {
  const resolvedRepository = repository ? repository : await resolveRepositorySlug(config, git);
  const fields = "number,title,body,state,labels,assignees,milestone,author,createdAt,updatedAt,url,comments";
  const issue = await gh.execJson<Record<string, JsonValue>>(
    ["issue", "view", String(number), "--repo", resolvedRepository, "--json", fields],
    config.repositoryPath ?? "",
  );
  return {
    ...issue,
    repository: resolvedRepository,
    labels: getLabelNames(issue.labels),
  } as unknown as GithubIssue;
}
