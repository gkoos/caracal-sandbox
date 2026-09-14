import type { Adapter } from "@gkoos/caracal"

export type WorkArgs = {
  /** How long the synthetic work takes. */
  workloadMs?: number
  /** Throw instead of resolving - the "dependency is failing" switch. */
  fail?: boolean
  /** Declared replay safety, so a demo can show retry being declined. */
  replay?: "safe" | "unsafe" | "unknown"
}

/** Sleeps, but resolves early when the attempt is cancelled. */
export function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * A synthetic dependency used by the smoke check and by any demo that wants to
 * exercise the policies without a network hop.
 *
 * It declares `abort: "supported"` and honours `context.signal`, which matters:
 * a bulkhead permit is held until the adapter promise settles, so an adapter that
 * ignores cancellation would make every timeout in the suite hold its permit to
 * the end - the same trap the PostgreSQL adapter documents rather than hides.
 */
export function syntheticAdapter(): Adapter<WorkArgs, string> {
  return {
    capabilities: (args) => ({
      abort: "supported",
      replay: args.replay ?? "safe",
    }),
    async execute(args, context) {
      await abortableDelay(args.workloadMs ?? 25, context.signal)
      if (args.fail) throw new Error("synthetic dependency failure")
      return "ok"
    },
    classify: (outcome) =>
      outcome.status === "success" ? "success" : "retryable",
  }
}
