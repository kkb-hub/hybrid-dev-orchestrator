// Composition of the config source order (see docs/architecture.md section 4).
// This module only knows how to combine already-parsed JSON objects; reading files
// from disk (and deciding which files exist) is a CLI/composition-root concern.
import type { JsonObject } from "../contracts/types.ts";
import { buildEffectiveConfig } from "./merge.ts";

export interface ConfigSource {
  /** Human-readable origin, e.g. an absolute path, used only for diagnostics. */
  origin: string;
  value: JsonObject;
}

export interface ResolvedConfigSources {
  config: JsonObject;
  sources: string[];
}

export function resolveConfigSources(defaultSource: ConfigSource, overlays: ConfigSource[]): ResolvedConfigSources {
  const config = buildEffectiveConfig(
    defaultSource.value,
    overlays.map((overlay) => overlay.value),
  );
  return {
    config,
    sources: [defaultSource.origin, ...overlays.map((overlay) => overlay.origin)],
  };
}
