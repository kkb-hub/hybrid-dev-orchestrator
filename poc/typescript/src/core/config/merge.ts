// Deep merge mirroring `Merge-HdoHashtable` in Common.ps1: objects merge key by key
// (recursively), arrays and scalars are replaced wholesale by the later source, and
// the override always wins on type mismatch. No array concatenation.
import type { JsonObject, JsonValue } from "../contracts/types.ts";

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMergeConfig(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMergeConfig(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

/**
 * Applies the HDO configuration source order left to right:
 * `config/hdo.default.json < user config < explicit --config overlays (left to right)`.
 * Repository-committed `.hdo/config.json` and programmatic overrides are intentionally
 * out of scope for this PoC (see README "非目標").
 */
export function buildEffectiveConfig(defaultConfig: JsonObject, overlays: JsonObject[]): JsonObject {
  return overlays.reduce((accumulated, overlay) => deepMergeConfig(accumulated, overlay), defaultConfig);
}
