import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Summary } from "./types.js"

function table(rows: [string, string | number | undefined][]): string {
  return [
    "| | |",
    "|---|---|",
    ...rows
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `| ${key} | ${value} |`),
  ].join("\n")
}

function distribution(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(
    (left, right) => right[1] - left[1],
  )
  if (entries.length === 0) return "none"
  return entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

/**
 * The artifact of a run: what was configured, what was measured, and whether the
 * checks passed.
 *
 * It is rendered from `summary.json` alone, so a run can be re-explained long
 * after the containers are gone, and a comparison is never done by reading
 * console output again.
 */
export function renderReport(summary: Summary): string {
  const passed = summary.checks.filter((check) => check.passed).length
  const lines: string[] = [
    `# ${summary.demo} - ${summary.title}`,
    "",
    `**Result: ${summary.passed ? "PASS" : "FAIL"}** (${passed}/${summary.checks.length} checks)`,
    "",
    `Run \`${summary.runId}\` - ${summary.startedAt} to ${summary.finishedAt}`,
    `caracal \`${summary.library.version}\` (${summary.library.source})`,
    "",
    "## Topology",
    "",
    table([
      ["policies", summary.topology.policies],
      ["scope", summary.topology.scope],
      ...Object.entries(summary.topology.config).map(
        ([key, value]) => [key, value] as [string, string | number],
      ),
    ]),
    "",
    "## Workload",
    "",
    table([
      ["duration", `${Math.round(summary.workload.durationMs / 1000)}s`],
      ["replicas", summary.workload.replicas],
      ["concurrency per replica", summary.workload.concurrency],
      ["target rate per replica", summary.workload.targetRpsPerReplica],
      ["by operation", distribution(summary.workload.byOperation)],
    ]),
    "",
    "## What the caller saw",
    "",
    table([
      ["requests", summary.client.requests],
      ["succeeded", summary.client.success],
      ["failed", summary.client.failure],
      ["refused", distribution(summary.client.refusedByReason)],
      ["timed out", summary.client.timedOut],
      [
        "latency p50 / p95 / p99",
        `${summary.client.latencyMs.p50} / ${summary.client.latencyMs.p95} / ${summary.client.latencyMs.p99} ms`,
      ],
      ["throughput", `${summary.client.rps}/s`],
    ]),
    "",
    "## What the dependency saw (the witness)",
    "",
  ]

  if (summary.witness) {
    lines.push(
      table([
        ["samples", summary.witness.samples],
        ["peak concurrent calls", summary.witness.peakInFlight],
        ["peak by scope", distribution(summary.witness.peakByScope)],
        ["requests", summary.witness.requests],
        ["failures served", summary.witness.failures],
        ["its own capacity", summary.witness.capacity],
      ]),
    )
  } else {
    lines.push(
      "_No witness for this run._ Claims based on the library's own reporting alone are not comparable.",
    )
  }

  lines.push(
    "",
    "## What caracal reported",
    "",
    table([
      ["executions", distribution(summary.caracal.executionsByOutcome)],
      ["attempts", distribution(summary.caracal.attemptsByClassification)],
      [
        "breaker state changes",
        distribution(summary.caracal.breakerStateChanges),
      ],
      ["breaker opens", summary.caracal.breakerOpens],
      ["opens by scope", distribution(summary.caracal.breakerOpensByScope)],
      [
        "bulkhead rejections",
        distribution(summary.caracal.bulkheadRejectionsByReason),
      ],
      [
        "peak probes in flight",
        distribution(summary.caracal.peakProbesInFlightByScope),
      ],
      ["retries scheduled", summary.caracal.retriesScheduled],
      ["retries declined", summary.caracal.retriesDeclined],
      ["timeouts triggered", summary.caracal.timeoutsTriggered],
      ["lease lost", summary.caracal.leaseLost],
      ["degraded", summary.caracal.degraded],
      ["stale observations dropped", summary.caracal.staleObservations],
      ["coordinator errors", summary.caracal.coordinatorErrors],
      ["permits leaked", summary.caracal.permitsLeaked],
    ]),
  )

  if (summary.coordination) {
    lines.push(
      "",
      "## Coordination cost",
      "",
      table([
        ["commands", summary.coordination.commands],
        [
          "EVALSHA / EVAL",
          `${summary.coordination.evalsha} / ${summary.coordination.eval}`,
        ],
        ["errors", summary.coordination.errors],
        [
          "round trips per execution",
          summary.coordination.roundTripsPerExecution,
        ],
      ]),
    )
  }

  lines.push(
    "",
    "## Checks",
    "",
    "| check | expected | actual | result |",
    "|---|---|---|---|",
  )
  for (const check of summary.checks) {
    lines.push(
      `| ${check.claim} | ${check.expected} | ${check.actual} | ${check.passed ? "pass" : "**FAIL**"} |`,
    )
  }

  if (summary.notes.length > 0) {
    lines.push("", "## Notes", "", ...summary.notes.map((note) => `- ${note}`))
  }

  lines.push("")
  return lines.join("\n")
}

export function writeReport(directory: string, summary: Summary): string {
  const path = join(directory, "report.md")
  writeFileSync(path, renderReport(summary))
  return path
}
