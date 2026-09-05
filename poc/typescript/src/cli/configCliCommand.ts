import type { PlatformAdapter } from "../platform/types.ts";
import type { ParsedArgs } from "./args.ts";
import { loadEffectiveConfig } from "./configCommand.ts";

export async function runConfigCliCommand(platform: PlatformAdapter, parsed: ParsedArgs): Promise<number> {
  try {
    const { config, sources, validation } = await loadEffectiveConfig({ configPaths: parsed.config, platform });
    const output = {
      schemaVersion: 1,
      valid: validation.valid,
      errors: validation.errors,
      sources,
      resolvedPaths: config.paths,
      config,
    };

    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`config valid: ${validation.valid}\n`);
      process.stdout.write(`sources:\n${sources.map((source) => ` - ${source}`).join("\n")}\n`);
      process.stdout.write(`resolved paths: ${JSON.stringify(config.paths)}\n`);
      if (!validation.valid) {
        process.stdout.write(`errors:\n${validation.errors.map((error) => ` - ${error}`).join("\n")}\n`);
      }
    }
    return validation.valid ? 0 : 2;
  } catch (error) {
    const message = (error as Error).message;
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`config error: ${message}\n`);
    }
    return 2;
  }
}
