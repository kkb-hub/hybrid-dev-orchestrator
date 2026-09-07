// Stdout/stderr diagnostics. Split into its own module because both main.ts's turn loop
// and compaction.ts's summarizer need the same `WARNING: ...` formatting PowerShell's
// `Write-Warning` produces, and neither module should depend on the other just to log.

/** Mirrors PowerShell's `Write-Warning`, which prints `WARNING: <message>` to the
 * error stream. Every `Write-Warning` call in the PS oracle is ported to this. */
export function warn(message: string): void {
  process.stderr.write(`WARNING: ${message}\n`);
}
