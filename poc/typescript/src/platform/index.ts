import { platform } from "node:os";
import { createPosixPlatformAdapter } from "./posix.ts";
import type { PlatformAdapter } from "./types.ts";
import { createWindowsPlatformAdapter } from "./windows.ts";

export type { PlatformAdapter } from "./types.ts";

export function getPlatform(): PlatformAdapter {
  return platform() === "win32" ? createWindowsPlatformAdapter() : createPosixPlatformAdapter();
}
