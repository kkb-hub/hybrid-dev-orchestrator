// Port of `Sync-HdoLabels` (GitHub.ps1:640-697).
import type { ConfigHost } from "../core/config/validate.ts";
import { validateConfiguration } from "../core/config/validate.ts";
import type { JsonObject, LabelCatalog, LabelSyncResult, ResolvedHdoConfig } from "../core/contracts/types.ts";
import type { GitClient } from "../git/index.ts";
import { resolveRepositorySlug, type GhClient } from "./client.ts";

/** Case-insensitive `-notcontains` equivalent (PowerShell's default string comparison). */
function includesCaseInsensitive(list: readonly string[], value: string): boolean {
  const target = value.toLowerCase();
  return list.some((item) => item.toLowerCase() === target);
}

/**
 * Maps a catalog label's fixed name (`config/labels.json`'s `staticLabels[].name`) to
 * whatever name it is actually configured under in `github.labels.*` - mirrors the
 * `$configuredNameByCatalogName` lookup table in `Sync-HdoLabels` (GitHub.ps1:657-668).
 */
function buildConfiguredNameByCatalogName(config: Pick<ResolvedHdoConfig, "github">): Record<string, string> {
  const labels = config.github?.labels;
  return {
    "hdo:ready": labels?.ready ?? "hdo:ready",
    "hdo:skip": labels?.skip ?? "hdo:skip",
    "hdo:status/claimed": labels?.claimed ?? "hdo:status/claimed",
    "hdo:status/implementing": labels?.implementing ?? "hdo:status/implementing",
    "hdo:status/review": labels?.review ?? "hdo:status/review",
    "hdo:status/changes-requested": labels?.changesRequested ?? "hdo:status/changes-requested",
    "hdo:status/approved": labels?.approved ?? "hdo:status/approved",
    "hdo:status/blocked": labels?.escalated ?? "hdo:status/blocked",
    "hdo:status/failed": labels?.failed ?? "hdo:status/failed",
    "hdo:status/cancelled": labels?.cancelled ?? "hdo:status/cancelled",
  };
}

export interface SyncLabelsOptions {
  repository?: string;
  apply?: boolean;
}

/**
 * Port of `Sync-HdoLabels` (GitHub.ps1:640-697). Configuration is validated FIRST
 * (`validateConfiguration`, the TS port of `Test-HdoConfiguration`) and this throws
 * before any `gh` call is made when it is invalid - the direct equivalent of
 * `tests/run-tests.ps1`'s "label synchronization rejects collisions before contacting
 * GitHub" oracle case.
 *
 * `catalog` (the parsed `config/labels.json`) is supplied by the caller rather than
 * read from disk here, matching the `SchemaRegistry`/`getIssueCandidate` composition
 * -root convention: `core`/`github` never touch the filesystem directly.
 *
 * There is no `-WhatIf`/`ShouldProcess` equivalent here (PowerShell's
 * `[CmdletBinding(SupportsShouldProcess)]` plus `$PSCmdlet.ShouldProcess(...)`): CLI
 * confirmation prompts are a phase-7 (cli/plugin) concern, not present anywhere else
 * in this TypeScript port yet either.
 */
export async function syncLabels(
  gh: GhClient,
  git: GitClient,
  config: ResolvedHdoConfig,
  host: ConfigHost,
  catalog: LabelCatalog,
  workingDirectory: string,
  options: SyncLabelsOptions = {},
): Promise<LabelSyncResult> {
  const configurationValidation = validateConfiguration(config as unknown as JsonObject, host);
  if (!configurationValidation.valid) {
    throw new Error(`Cannot synchronize labels with invalid configuration: ${configurationValidation.errors.join("; ")}`);
  }
  const repository = options.repository ?? (await resolveRepositorySlug({ github: config.github, repositoryPath: workingDirectory }, git));

  const existing = await gh.execJson<Array<{ name: string; color: string; description: string }>>(
    ["label", "list", "--repo", repository, "--limit", "1000", "--json", "name,color,description"],
    workingDirectory,
  );
  const existingNames = existing.map((label) => label.name);
  const configuredNameByCatalogName = buildConfiguredNameByCatalogName(config);

  const labelsToSync: Array<{ name: string; color: string; description: string }> = [];
  for (const catalogLabel of catalog.staticLabels ?? []) {
    const name = Object.prototype.hasOwnProperty.call(configuredNameByCatalogName, catalogLabel.name)
      ? configuredNameByCatalogName[catalogLabel.name]
      : catalogLabel.name;
    labelsToSync.push({ name, color: catalogLabel.color, description: catalogLabel.description });
  }
  const dynamicDefinition = (catalog.dynamicLabels ?? [])[0];
  if (dynamicDefinition) {
    for (const profileName of Object.keys(config.profiles ?? {})) {
      labelsToSync.push({
        name: `${dynamicDefinition.prefix}${profileName}`,
        color: dynamicDefinition.color,
        description: dynamicDefinition.descriptionTemplate.replace("{value}", profileName),
      });
    }
  }

  const changes: LabelSyncResult["labels"] = [];
  const apply = Boolean(options.apply);
  for (const label of labelsToSync) {
    const missing = !includesCaseInsensitive(existingNames, label.name);
    const change = { name: label.name, missing, applied: false };
    changes.push(change);
    if (apply) {
      await gh.execThrowing(
        ["label", "create", label.name, "--repo", repository, "--color", label.color, "--description", label.description, "--force"],
        workingDirectory,
      );
      change.applied = true;
    }
  }

  return { repository, apply, labels: changes };
}
