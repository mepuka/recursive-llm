export const resolveWorkerPath = (): string => {
  if (process.env.RLM_COMPILED === "1") {
    return new URL("sandbox-worker.js", `file://${process.execPath}`).pathname
  }
  return new URL("./sandbox-worker.ts", import.meta.url).pathname
}
