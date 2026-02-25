/**
 * Build script for recursive-llm CLI binary.
 *
 * Produces two artifacts in dist/:
 *   - sandbox-worker.js  — bundled JS (spawned as subprocess)
 *   - rlm                — compiled single-file binary
 *
 * Usage:
 *   bun run build                      # build for current platform
 *   bun run build bun-linux-x64        # cross-compile for linux x64
 */

import { rmSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const target = (process.argv[2] ?? "bun") as
  | "bun"
  | `bun-${string}`

const root = resolve(import.meta.dirname!, "..")
const dist = resolve(root, "dist")

// Clean & create dist/
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 1. Bundle sandbox worker → dist/sandbox-worker.js
console.log("Bundling sandbox-worker.js...")
const workerResult = await Bun.build({
  entrypoints: [resolve(root, "src/sandbox-worker.ts")],
  outdir: dist,
  target: "bun",
  minify: true,
  naming: "sandbox-worker.js",
})

if (!workerResult.success) {
  console.error("Worker bundle failed:")
  for (const log of workerResult.logs) {
    console.error(log)
  }
  process.exit(1)
}
console.log("  → dist/sandbox-worker.js")

// 2. Compile CLI binary → dist/rlm
console.log(`Compiling rlm binary (target: ${target})...`)
const compileArgs = [
  "bun", "build",
  resolve(root, "src/cli.ts"),
  "--compile",
  "--minify",
  "--target", target,
  "--outfile", resolve(dist, "rlm"),
  "--define", "process.env.RLM_COMPILED='1'",
]

const proc = Bun.spawn(compileArgs, {
  stdout: "inherit",
  stderr: "inherit",
  cwd: root,
})

const exitCode = await proc.exited
if (exitCode !== 0) {
  console.error(`CLI compile failed with exit code ${exitCode}`)
  process.exit(1)
}
console.log("  → dist/rlm")

console.log("\nBuild complete. Both files must be in the same directory to run.")
