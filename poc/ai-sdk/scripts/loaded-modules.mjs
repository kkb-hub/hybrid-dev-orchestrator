#!/usr/bin/env node
// Counts the third-party code that is actually LOADED INTO THE PROCESS when an entry
// point is imported, as opposed to merely installed on disk.
//
// Why this and not `npm ls` / `du`: ADR-0003 D3 puts the workspace-write capability in
// the same process as whatever harness runs the tool loop. What matters for that boundary
// is not how many megabytes `npm ci` wrote, but how much third-party code executes beside
// the code that can write to the user's repository. Those two numbers differ by more than
// an order of magnitude for the AI SDK (most of `zod`'s and `undici`'s bulk never loads,
// or never loads at all), and quoting the disk figure alone would overstate the exposure
// while quoting nothing would understate it.
//
// Method: an ESM `load` hook (node:module `register`) reports every resolved module URL
// under a `node_modules/` directory back over a MessagePort. The hook sees each module
// exactly once, at first load, so the count is "distinct module files evaluated", and the
// byte total is the on-disk size of just those files.
//
// Usage:
//   node poc/ai-sdk/scripts/loaded-modules.mjs ai
//   node poc/ai-sdk/scripts/loaded-modules.mjs ollama-ai-provider-v2
//
// The zero-dependency baseline (src/workers/leanWorker/) needs no run: it imports nothing
// outside `node:` builtins, so its count is structurally zero. `grep -rn "^import" ` over
// that directory is the check that this stays true.
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: node scripts/loaded-modules.mjs <module-specifier>\n");
  process.exit(2);
}

const { port1, port2 } = new MessageChannel();
const urls = [];
port1.on("message", (url) => urls.push(url));
// Without unref the live port would hold the event loop open after the report is printed.
port1.unref();
register("./loaded-modules-hook.mjs", { parentURL: import.meta.url, data: { port: port2 }, transferList: [port2] });

await import(target);
// The hook posts across a port, so the last few messages can still be in flight when the
// import settles.
await new Promise((resolve) => setTimeout(resolve, 300));

const files = [...new Set(urls)];
const packages = new Map();
let bytes = 0;
for (const url of files) {
  const filePath = fileURLToPath(url);
  try {
    bytes += statSync(filePath).size;
  } catch {
    // A module that resolved but cannot be stat'ed contributes to the count, not the size.
  }
  const match = filePath.split("\\").join("/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.set(match[1], (packages.get(match[1]) ?? 0) + 1);
}

process.stdout.write(`entry point: ${target}\n`);
process.stdout.write(`third-party module files loaded: ${files.length}\n`);
process.stdout.write(`on-disk size of those files: ${(bytes / 1024 / 1024).toFixed(2)} MB\n`);
process.stdout.write(`distinct packages loaded: ${packages.size}\n`);
for (const [name, count] of [...packages].sort()) {
  process.stdout.write(`  ${name} (${count} file${count === 1 ? "" : "s"})\n`);
}
