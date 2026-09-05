// Read-only minimal git client for phase 1 (config/state only - worktree/diff
// operations are phase 3, ADR-0001 Migration strategy). Built directly on
// `node:child_process` `execFile` with an argv array (never a shell string,
// `shell: false`), mirroring the "no shell string" runtime convention the ADR sets
// for the eventual `NodeProcessRunner` (phase 2) without pulling in its full bounded
// -output/timeout machinery, which this phase does not need.
import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitClientOptions {
  gitExecutable?: string;
  /** Generous ceiling on captured stdout/stderr; phase 1 only reads small config blobs. */
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Mirrors `Invoke-HdoProcess -ThrowOnError`'s throw text (Common.ps1) exactly:
 * `Command '<command>' failed with exit code <code>. <detail>`, where `<detail>` is
 * trimmed stderr, falling back to trimmed stdout when stderr is empty.
 */
export function formatProcessFailure(command: string, exitCode: number, stdout: string, stderr: string): string {
  const detail = stderr.trim() || stdout.trim();
  return `Command '${command}' failed with exit code ${exitCode}. ${detail}`;
}

export class GitClient {
  private readonly gitExecutable: string;
  private readonly maxBufferBytes: number;

  constructor(options: GitClientOptions = {}) {
    this.gitExecutable = options.gitExecutable ?? "git";
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  /** Runs `git <args>` in `cwd` and always resolves (never rejects) with the exit code and captured output. */
  exec(args: string[], cwd: string): Promise<GitCommandResult> {
    return new Promise((resolveResult) => {
      execFile(
        this.gitExecutable,
        args,
        { cwd, shell: false, windowsHide: true, encoding: "utf8", maxBuffer: this.maxBufferBytes },
        (error, stdout, stderr) => {
          if (error) {
            const errno = error as NodeJS.ErrnoException;
            if (typeof errno.code !== "number") {
              // The process never started (ENOENT, EACCES, ...) - no real exit code exists.
              // 127 mirrors the shell convention for "command not found"/"could not execute".
              resolveResult({ exitCode: 127, stdout: stdout ?? "", stderr: stderr || errno.message });
              return;
            }
            resolveResult({ exitCode: errno.code, stdout: stdout ?? "", stderr: stderr ?? "" });
            return;
          }
          resolveResult({ exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  }

  /** `git rev-parse --verify <ref>` - never throws; callers inspect `exitCode`. */
  async revParseVerify(repositoryPath: string, ref: string): Promise<GitCommandResult> {
    return this.exec(["rev-parse", "--verify", ref], repositoryPath);
  }

  /** `git show <object>` - never throws; callers inspect `exitCode`. */
  async show(repositoryPath: string, objectName: string): Promise<GitCommandResult> {
    return this.exec(["show", objectName], repositoryPath);
  }

  /**
   * Mirrors `Get-HdoRepositoryRoot` (Git.ps1): `git rev-parse --show-toplevel`,
   * throwing on failure, then normalizing the result to a native full path
   * (`[System.IO.Path]::GetFullPath`) so forward slashes Git may emit on Windows
   * become the platform's native separator.
   */
  async repositoryRoot(path: string): Promise<string> {
    const result = await this.exec(["rev-parse", "--show-toplevel"], path);
    if (result.exitCode !== 0) {
      // Invoke-HdoGit always passes the literal command name 'git' to
      // Invoke-HdoProcess, regardless of the resolved executable path - so the
      // message text does too, not `this.gitExecutable` (which may be overridden
      // for tests).
      throw new Error(formatProcessFailure("git", result.exitCode, result.stdout, result.stderr));
    }
    return resolvePath(result.stdout.trim());
  }
}
