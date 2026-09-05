// Rule-for-rule port of `Test-HdoConfiguration` (Configuration.ps1). Error/warning
// message strings are copied verbatim from the PowerShell source. Path containment
// needs host functions (worktreeRoot/artifactRoot/projectContractPath live on the
// filesystem, which core does not touch), so those are injected via `ConfigHost`.
import type { JsonObject, JsonValue } from "../contracts/types.ts";
import { findKeyIgnoreCase, getValue } from "./value.ts";

export interface ConfigHost {
  /**
   * PowerShell compares `worktreeRoot -eq repositoryPath` (and similar pairs) with
   * the bare `-eq` operator, which is case-insensitive for strings on every platform
   * regardless of `$IsWindows`. This is a Windows-first port (ADR-0001 Amendment
   * 2026-09-05): `src/platform/windows.ts`'s `pathEquals` matches `-eq`'s
   * case-insensitivity, but `src/platform/posix.ts`'s `pathEquals` compares
   * case-sensitively (plain path equality after trimming a trailing separator) by
   * design - a documented, intentional divergence from PowerShell `-eq` on POSIX,
   * not a bug to fix. Callers inject whichever comparator their platform adapter
   * provides (see docs/architecture.md and src/git for the Windows short-name/
   * symlink nuances that also apply here).
   */
  pathEquals(a: string, b: string): boolean;
  /** Mirrors `Test-HdoPathWithinRoot`: true iff `child` is a strict descendant of `root`. */
  isPathWithinRoot(child: string, root: string): boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: JsonValue | undefined, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * `[int]` cast equivalent. The JSON Schema already constrains these to integers
 * where it matters; `Number()` is a faithful enough coercion for the defensive
 * casts here (PowerShell's `[int]` uses banker's rounding on non-integers, which
 * cannot be reached through schema-valid input in the first place).
 */
function asNumber(value: JsonValue | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/** PowerShell truthiness for the value shapes `Get-HdoValue` can return. */
function isTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return true; // non-null plain object: PowerShell hashtables are truthy even when empty
}

/**
 * `@(Get-HdoValue $runner $key @()).Count`: a missing key defaults to an empty
 * array (count 0); an array value contributes its own length; any other present
 * value (including an explicit JSON `null`, matching `@($null).Count -eq 1`) counts
 * as exactly one element, mirroring PowerShell's `@(...)` array cast around a
 * scalar.
 */
function hdoArrayCount(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}

function hdoArrayItems(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function startsWithCaseInsensitive(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** Case-insensitive `HashSet<string>.Add`: returns true iff `value` was newly added. */
function addCaseInsensitive(set: Set<string>, value: string): boolean {
  const key = value.toLowerCase();
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

const CATALOG_LABELS = [
  "hdo:priority/p0",
  "hdo:priority/p1",
  "hdo:priority/p2",
  "hdo:priority/p3",
  "hdo:risk/low",
  "hdo:risk/medium",
  "hdo:risk/high",
  "hdo:risk/critical",
];

export function validateConfiguration(config: JsonObject, host: ConfigHost): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (asNumber(getValue(config, "schemaVersion", 0), 0) !== 1) {
    errors.push("schemaVersion must be 1.");
  }

  const maxFixAttempts = asNumber(getValue(config, "workflow.maxFixAttempts", -1), -1);
  if (maxFixAttempts < 0 || maxFixAttempts > 10) {
    errors.push("workflow.maxFixAttempts must be between 0 and 10.");
  }

  const githubLabels = getValue(config, "github.labels", {});
  if (isPlainObject(githubLabels)) {
    const readyLabel = asString(getValue(githubLabels, "ready", ""));
    const skipLabel = asString(getValue(githubLabels, "skip", ""));
    const statusPrefix = asString(getValue(githubLabels, "statusPrefix", ""));
    if (statusPrefix.toLowerCase() !== "hdo:status/") errors.push("github.labels.statusPrefix must be 'hdo:status/'.");
    if (!startsWithCaseInsensitive(readyLabel, "hdo:") || startsWithCaseInsensitive(readyLabel, statusPrefix)) {
      errors.push("github.labels.ready must be in the hdo: namespace and outside the status prefix.");
    }
    if (!startsWithCaseInsensitive(skipLabel, "hdo:") || startsWithCaseInsensitive(skipLabel, statusPrefix)) {
      errors.push("github.labels.skip must be in the hdo: namespace and outside the status prefix.");
    }
    for (const labelKey of ["ready", "skip"] as const) {
      const labelName = asString(getValue(githubLabels, labelKey, ""));
      if (/^hdo:(?:priority|risk|route)\//i.test(labelName)) {
        errors.push(`github.labels.${labelKey} cannot use a priority, risk, or route label namespace.`);
      }
    }
    const managedLabelNames = new Set<string>();
    for (const labelKey of ["ready", "skip"] as const) {
      const labelName = asString(getValue(githubLabels, labelKey, ""));
      if (labelName && !addCaseInsensitive(managedLabelNames, labelName)) {
        errors.push(`GitHub managed label '${labelName}' is configured more than once.`);
      }
    }
    for (const labelKey of [
      "claimed",
      "implementing",
      "review",
      "changesRequested",
      "approved",
      "escalated",
      "failed",
      "cancelled",
    ] as const) {
      const labelName = asString(getValue(githubLabels, labelKey, ""));
      if (!startsWithCaseInsensitive(labelName, statusPrefix) || labelName.toLowerCase() === statusPrefix.toLowerCase()) {
        errors.push(`github.labels.${labelKey} must be a label below '${statusPrefix}'.`);
      }
      if (labelName && !addCaseInsensitive(managedLabelNames, labelName)) {
        errors.push(`GitHub managed label '${labelName}' is configured more than once.`);
      }
    }
    for (const catalogLabel of CATALOG_LABELS) {
      if (!addCaseInsensitive(managedLabelNames, catalogLabel)) {
        errors.push(`GitHub managed label '${catalogLabel}' collides with a fixed catalog label.`);
      }
    }
    const profilesForLabels = getValue(config, "profiles", {});
    if (isPlainObject(profilesForLabels)) {
      for (const profileName of Object.keys(profilesForLabels)) {
        const routeLabel = `hdo:route/${profileName}`;
        if (!addCaseInsensitive(managedLabelNames, routeLabel)) {
          errors.push(`GitHub managed label '${routeLabel}' collides with a generated route label.`);
        }
      }
    }
  }

  const priorityOrder = getValue(config, "github.priorityOrder", []);
  for (const priorityLabel of hdoArrayItems(priorityOrder)) {
    const text = asString(priorityLabel);
    if (!/^hdo:priority\/p[0-3]$/i.test(text)) {
      errors.push(`github.priorityOrder contains unsupported label '${text}'.`);
    }
  }

  for (const pathName of ["paths.worktreeRoot", "paths.artifactRoot"]) {
    if (!getValue(config, pathName, "")) errors.push(`${pathName} is required.`);
  }

  const repositoryPath = asString(getValue(config, "repositoryPath", ""));
  const projectContractPath = asString(getValue(config, "projectContractPath", ""));
  if (repositoryPath && projectContractPath && !host.isPathWithinRoot(projectContractPath, repositoryPath)) {
    errors.push("projectContractPath must resolve inside repositoryPath.");
  }
  if (repositoryPath) {
    const worktreeRoot = asString(getValue(config, "paths.worktreeRoot", ""));
    const artifactRoot = asString(getValue(config, "paths.artifactRoot", ""));
    if (worktreeRoot && (host.pathEquals(worktreeRoot, repositoryPath) || host.isPathWithinRoot(worktreeRoot, repositoryPath))) {
      errors.push("paths.worktreeRoot must be outside repositoryPath.");
    }
    if (artifactRoot && (host.pathEquals(artifactRoot, repositoryPath) || host.isPathWithinRoot(artifactRoot, repositoryPath))) {
      errors.push("paths.artifactRoot must be outside repositoryPath.");
    }
    if (
      worktreeRoot &&
      artifactRoot &&
      (host.pathEquals(worktreeRoot, artifactRoot) ||
        host.isPathWithinRoot(worktreeRoot, artifactRoot) ||
        host.isPathWithinRoot(artifactRoot, worktreeRoot))
    ) {
      errors.push("paths.worktreeRoot and paths.artifactRoot must not overlap.");
    }
  }

  let runners = getValue(config, "runners");
  if (!isPlainObject(runners)) {
    errors.push("runners must be an object.");
    runners = {};
  }
  let steps = getValue(config, "steps");
  if (!isPlainObject(steps)) {
    errors.push("steps must be an object.");
    steps = {};
  }

  // `$steps.Contains(...)`/`$steps[...]` are case-insensitive on PowerShell's
  // OrderedDictionary; a -SetStep override applied after schema validation can leave
  // a differently-cased key (e.g. "IMPLEMENT") in `steps`, so these lookups must be too.
  for (const requiredStep of ["implement", "review", "fix"]) {
    if (findKeyIgnoreCase(steps as JsonObject, requiredStep) === undefined) {
      errors.push(`steps.${requiredStep} is required.`);
    }
  }

  for (const stepName of ["plan", "implement", "review", "fix"] as const) {
    const matchedStepKey = findKeyIgnoreCase(steps as JsonObject, stepName);
    if (matchedStepKey === undefined) continue;
    const binding = (steps as JsonObject)[matchedStepKey];
    let enabled = true;
    let runnerName: string | null = null;
    if (typeof binding === "string") {
      runnerName = binding;
    } else if (isPlainObject(binding)) {
      enabled = isTruthy(getValue(binding, "enabled", true));
      runnerName = asString(getValue(binding, "runner", ""));
    } else {
      errors.push(`steps.${stepName} must be a runner name or an object.`);
      continue;
    }
    if (!enabled) {
      if (stepName !== "plan") errors.push(`Only the plan step may be disabled; '${stepName}' is required.`);
      continue;
    }
    // Runner names normally come from a schema-validated (lowercase-only) `steps`
    // binding, but `-SetStep` can inject an arbitrary-cased reference after schema
    // validation has already run - PowerShell's `$runners.Contains($runnerName)` is
    // case-insensitive regardless, so the lookup must be too.
    const matchedRunnerKey = runnerName ? findKeyIgnoreCase(runners as JsonObject, runnerName) : undefined;
    if (!runnerName || matchedRunnerKey === undefined) {
      errors.push(`steps.${stepName} references undefined runner '${runnerName}'.`);
      continue;
    }

    const runner = (runners as JsonObject)[matchedRunnerKey];
    const runnerObject = isPlainObject(runner) ? runner : {};
    const type = asString(getValue(runnerObject, "type", ""));
    if (!["codex", "claude", "command"].includes(type)) {
      errors.push(`Runner '${runnerName}' has unsupported type '${type}'.`);
    }
    if (!getValue(runnerObject, "command", "")) {
      errors.push(`Runner '${runnerName}' must define command.`);
    }
    const provider = asString(getValue(runnerObject, "provider", "cloud"), "cloud");
    if (!["cloud", "ollama", "lmstudio", "custom"].includes(provider)) {
      errors.push(`Runner '${runnerName}' has unsupported provider '${provider}'.`);
    }
    if (type === "codex" && !["cloud", "ollama", "lmstudio"].includes(provider)) {
      errors.push(`Codex runner '${runnerName}' cannot use provider '${provider}'.`);
    }
    if (type === "claude" && !["cloud", "ollama"].includes(provider)) {
      errors.push(`Claude runner '${runnerName}' cannot use provider '${provider}'.`);
    }
    const contextTokensRaw = getValue(runnerObject, "contextTokens");
    if (type === "claude" && provider !== "ollama" && isTruthy(contextTokensRaw)) {
      errors.push(
        `Claude runner '${runnerName}' cannot set contextTokens for provider '${provider}'; the Claude CLI exposes no context-window argument against Anthropic's API. Set provider 'ollama' to let HDO enforce it via a derived local model instead.`,
      );
    }
    if (type === "claude" && provider === "ollama" && isTruthy(contextTokensRaw) && asNumber(contextTokensRaw, 0) < 57344) {
      errors.push(
        `Claude/Ollama runner '${runnerName}' contextTokens ${asNumber(contextTokensRaw, 0)} is below the usable floor of 57344; the Claude CLI reserves 23000 tokens of the declared window before it will send a prompt at all, so smaller windows fail every step with 'Prompt is too long'. Use 65536, or route implement/fix to a cloud runner if the GPU cannot hold that many tokens.`,
      );
    }
    const reasoningEffort = asString(getValue(runnerObject, "reasoningEffort", ""));
    if (type === "claude" && reasoningEffort && !["low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) {
      errors.push(
        `Claude runner '${runnerName}' reasoningEffort '${reasoningEffort}' is not supported; the Claude CLI --effort accepts low, medium, high, xhigh, or max and silently ignores other values.`,
      );
    }
    if (type === "claude" && provider === "ollama" && reasoningEffort) {
      errors.push(
        `Claude/Ollama runner '${runnerName}' cannot set reasoningEffort because Claude CLI validates --effort against its cloud model catalog.`,
      );
    }
    if (["ollama", "lmstudio"].includes(provider) && !getValue(runnerObject, "model", "")) {
      errors.push(`Local runner '${runnerName}' must define model.`);
    }
    const sandbox = asString(getValue(runnerObject, "sandbox", ""));
    if (!["read-only", "workspace-write"].includes(sandbox)) {
      errors.push(`Runner '${runnerName}' sandbox must be read-only or workspace-write.`);
    }
    if (["plan", "review"].includes(stepName) && sandbox !== "read-only") {
      errors.push(`The ${stepName} step must use a read-only runner; '${runnerName}' uses '${sandbox}'.`);
    }
    if (["implement", "fix"].includes(stepName) && sandbox !== "workspace-write") {
      errors.push(`The ${stepName} step must use a workspace-write runner; '${runnerName}' uses '${sandbox}'.`);
    }
    const timeout = asNumber(getValue(runnerObject, "timeoutSeconds", 0), 0);
    if (timeout < 1 || timeout > 86400) {
      errors.push(`Runner '${runnerName}' timeoutSeconds must be between 1 and 86400.`);
    }
    if (hdoArrayCount(getValue(runnerObject, "fallback", [])) > 0) {
      errors.push(`Runner '${runnerName}' declares fallback. Implicit provider/model fallback is not supported.`);
    }
    // A blocklist cannot durably protect the Claude adapter's isolation guarantees
    // (--safe-mode, --permission-mode, --json-schema, ...) against the CLI's evolving
    // flag surface, so claude runners may not declare extraArgs at all.
    if (type === "claude" && hdoArrayCount(getValue(runnerObject, "extraArgs", [])) > 0) {
      errors.push(
        `Claude runner '${runnerName}' may not use extraArgs; the Claude adapter controls the full claude argument surface. Use a 'command' runner when a custom argument layout is required.`,
      );
    }
    for (const extraArgument of hdoArrayItems(getValue(runnerObject, "extraArgs", []))) {
      const argumentText = asString(extraArgument);
      if (/[\u0000\r\n]/.test(argumentText)) {
        errors.push(`Runner '${runnerName}' has an argument containing a line break or NUL.`);
      }
      if (/(danger-full-access|bypasspermissions|dangerously-(?:bypass|skip)|^--search(?:=|$))/i.test(argumentText)) {
        errors.push(`Runner '${runnerName}' uses forbidden argument '${extraArgument}'.`);
      }
      if (
        type === "codex" &&
        /^(?:--sandbox|-s|--cd|-C|--output-schema|--output-last-message|--json-schema|--output-format)(?:=|$)/i.test(
          argumentText,
        )
      ) {
        errors.push(`Runner '${runnerName}' may not override adapter-controlled argument '${extraArgument}'.`);
      }
      if (/(?:ghp_|github_pat_|sk-ant-|sk-proj-|xox[baprs]-)[-A-Za-z0-9_]{12,}/i.test(argumentText)) {
        errors.push(`Runner '${runnerName}' extraArgs appears to contain a credential literal.`);
      }
    }
    if (type !== "command" && isTruthy(getValue(runnerObject, "promptTransport"))) {
      errors.push(`Runner '${runnerName}' may use promptTransport only with type 'command'.`);
    }
    if (type !== "claude" && hdoArrayCount(getValue(runnerObject, "allowedTools", [])) > 0) {
      errors.push(`Runner '${runnerName}' may use allowedTools only with type 'claude'.`);
    }
    for (const environmentName of hdoArrayItems(getValue(runnerObject, "passEnvironment", []))) {
      const name = asString(environmentName);
      if (/GH_TOKEN|GITHUB_TOKEN/i.test(name)) {
        errors.push(`Runner '${runnerName}' must not receive GitHub control-plane credentials.`);
      } else if (/(TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(name)) {
        warnings.push(`Runner '${runnerName}' explicitly receives sensitive environment variable '${name}'.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
