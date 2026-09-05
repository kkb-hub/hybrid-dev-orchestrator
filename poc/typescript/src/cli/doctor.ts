import type { PlatformAdapter } from "../platform/types.ts";
import { loadEffectiveConfig } from "./configCommand.ts";

interface DoctorCheck {
  name: string;
  status: "pass" | "fail";
  detail: string;
}

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 18;

function meetsMinimumNode(versionString: string): boolean {
  const [majorText, minorText] = versionString.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major !== MINIMUM_NODE_MAJOR) return major > MINIMUM_NODE_MAJOR;
  return minor >= MINIMUM_NODE_MINOR;
}

/** Checks Node version, git availability, and that config loads & validates. Exit 3 on any failure. */
export async function runDoctor(platform: PlatformAdapter, json: boolean): Promise<number> {
  const checks: DoctorCheck[] = [];

  const nodeVersion = process.versions.node;
  checks.push({
    name: "node-version",
    status: meetsMinimumNode(nodeVersion) ? "pass" : "fail",
    detail: `node ${nodeVersion} (requires >= ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR} for native type stripping)`,
  });

  const gitExecutableName = process.platform === "win32" ? "git.exe" : "git";
  const gitPath = platform.resolveExecutable(gitExecutableName);
  checks.push({
    name: "git",
    status: gitPath ? "pass" : "fail",
    detail: gitPath ? `resolved: ${gitPath}` : `${gitExecutableName} was not found on PATH`,
  });

  try {
    const { validation, sources } = await loadEffectiveConfig({ configPaths: [], platform });
    checks.push({
      name: "config",
      status: validation.valid ? "pass" : "fail",
      detail: validation.valid
        ? `loaded and validated from ${sources.length} source(s): ${sources.join(", ")}`
        : validation.errors.join("; "),
    });
  } catch (error) {
    checks.push({ name: "config", status: "fail", detail: (error as Error).message });
  }

  const ok = checks.every((check) => check.status === "pass");
  const summary = { schemaVersion: 1, ok, checks };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const check of checks) {
      process.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}\n`);
    }
    process.stdout.write(ok ? "doctor: OK\n" : "doctor: FAILED\n");
  }
  return ok ? 0 : 3;
}
