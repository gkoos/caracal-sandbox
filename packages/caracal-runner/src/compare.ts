import type { Summary } from "./types.js"

/**
 * One KPI, read from every run being compared.
 *
 * `better` drives the verdict column, and it is only set where there is a real
 * direction: more throughput is better, more breaker opens is not, and a raw
 * request count has no direction at all.
 */
export type Kpi = {
  label: string
  numeric?(summary: Summary): number | undefined
  render(summary: Summary): string
  better?: "lower" | "higher"
  note?: string
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

function percent(part: number, total: number): string {
  if (total === 0) return "n/a"
  return `${((part / total) * 100).toFixed(1)}%`
}

function peakProbes(summary: Summary): number {
  return Object.values(summary.caracal.peakProbesInFlightByScope).reduce(
    (peak, value) => Math.max(peak, value),
    0,
  )
}

function seconds(summary: Summary): number {
  return Math.max(1, (summary.workload.durationMs ?? 0) / 1000)
}

function rejectedCount(summary: Summary): number {
  return sum(summary.client.refusedByReason) + summary.client.timedOut
}

function bulkheadLimit(summary: Summary): number | undefined {
  const value = summary.topology.config["bulkhead limit"]
  return typeof value === "number" ? value : undefined
}

export const KPIS: Kpi[] = [
  {
    label: "witness peak in-flight",
    better: "lower",
    note: "the dependency's own count of concurrent calls",
    numeric: (summary) => summary.witness?.peakInFlight,
    render: (summary) =>
      summary.witness ? String(summary.witness.peakInFlight) : "n/a",
  },
  {
    label: "breaker opens",
    better: "lower",
    numeric: (summary) => summary.caracal.breakerOpens,
    render: (summary) => String(summary.caracal.breakerOpens),
  },
  {
    label: "peak probes in flight",
    better: "lower",
    numeric: peakProbes,
    render: (summary) => String(peakProbes(summary)),
  },
  {
    label: "refused by a policy",
    better: "lower",
    note: "shedding is the distributed bulkhead working, not a defect",
    numeric: (summary) => sum(summary.client.refusedByReason),
    render: (summary) => String(sum(summary.client.refusedByReason)),
  },
  {
    label: "success rate",
    better: "higher",
    numeric: (summary) =>
      summary.client.requests === 0
        ? undefined
        : summary.client.success / summary.client.requests,
    render: (summary) =>
      percent(summary.client.success, summary.client.requests),
  },
  {
    label: "p99 latency",
    better: "lower",
    numeric: (summary) => summary.client.latencyMs.p99,
    render: (summary) => `${summary.client.latencyMs.p99}ms`,
  },
  {
    label: "offered requests/s",
    note: "everything the driver issued, refused or not",
    numeric: (summary) => summary.client.rps,
    render: (summary) => `${summary.client.rps}/s`,
  },
  {
    label: "successful requests/s",
    better: "higher",
    note: "work that actually completed",
    numeric: (summary) => Math.round(summary.client.success / seconds(summary)),
    render: (summary) =>
      `${Math.round(summary.client.success / seconds(summary))}/s`,
  },
  {
    label: "rejected requests/s",
    better: "lower",
    note: "shed by a policy or timed out",
    numeric: (summary) => Math.round(rejectedCount(summary) / seconds(summary)),
    render: (summary) =>
      `${Math.round(rejectedCount(summary) / seconds(summary))}/s`,
  },
  {
    label: "witness peak / bulkhead limit",
    note: "how far the dependency was pushed versus its configured ceiling",
    numeric: (summary) => summary.witness?.peakInFlight,
    render: (summary) =>
      summary.witness
        ? `${summary.witness.peakInFlight} / ${bulkheadLimit(summary) ?? "?"}`
        : "n/a",
  },
  {
    label: "requests",
    numeric: (summary) => summary.client.requests,
    render: (summary) => String(summary.client.requests),
  },
  {
    label: "coordinator trips/exec",
    better: "lower",
    numeric: (summary) => summary.coordination?.roundTripsPerExecution,
    render: (summary) =>
      summary.coordination
        ? String(summary.coordination.roundTripsPerExecution)
        : "n/a",
  },
  {
    label: "lease lost",
    better: "lower",
    numeric: (summary) => summary.caracal.leaseLost,
    render: (summary) => String(summary.caracal.leaseLost),
  },
  {
    label: "checks",
    better: "higher",
    numeric: (summary) =>
      summary.checks.filter((check) => check.passed).length /
      Math.max(1, summary.checks.length),
    render: (summary) =>
      `${summary.checks.filter((check) => check.passed).length}/${summary.checks.length}`,
  },
  {
    label: "result",
    better: "higher",
    numeric: (summary) => (summary.passed ? 1 : 0),
    render: (summary) => (summary.passed ? "pass" : "FAIL"),
  },
]

export type ComparisonTable = {
  headers: string[]
  rows: string[][]
  /** Row index -> winning column index (into `summaries`). */
  best: Map<number, number>
}

export function comparisonTable(
  summaries: readonly Summary[],
): ComparisonTable {
  const headers = ["KPI", ...summaries.map((summary) => summary.demo)]
  const rows: string[][] = []
  const best = new Map<number, number>()

  KPIS.forEach((kpi, rowIndex) => {
    rows.push([kpi.label, ...summaries.map((summary) => kpi.render(summary))])
    if (!kpi.better || !kpi.numeric) return
    const values = summaries.map((summary) => kpi.numeric?.(summary))
    const present = values.filter(
      (value): value is number => value !== undefined,
    )
    // A verdict needs at least two runs that actually differ: a column of
    // identical numbers (or of `n/a`) is not a result.
    if (present.length < 2 || new Set(present).size === 1) return
    const target =
      kpi.better === "lower" ? Math.min(...present) : Math.max(...present)
    const winner = values.indexOf(target)
    if (winner >= 0) best.set(rowIndex, winner)
  })

  return { headers, rows, best }
}

/** Fixed-width table for a terminal. */
export function renderTable(
  headers: readonly string[],
  rows: readonly string[][],
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  )
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd()
  const separator = widths.map((width) => "-".repeat(width)).join("  ")
  return [line(headers), separator, ...rows.map((row) => line(row))].join("\n")
}

/** The comparison the demos exist for: every KPI, side by side, with a verdict. */
export function renderComparison(summaries: readonly Summary[]): string {
  const { headers, rows, best } = comparisonTable(summaries)
  const withVerdict = rows.map((row, rowIndex) => {
    const kpi = KPIS[rowIndex]
    const winner = best.get(rowIndex)
    if (winner === undefined || !kpi) {
      if (!kpi?.better) return [...row, ""]
      // A tie and a missing value are different: "same" means both measured it,
      // "n/a" means at least one run could not.
      const measured = summaries.filter(
        (summary) => kpi.numeric?.(summary) !== undefined,
      ).length
      return [...row, measured < 2 ? "n/a" : "same"]
    }
    const name = summaries[winner]?.demo ?? "?"
    return [
      ...row,
      `${name} (${kpi.better === "lower" ? "lower" : "higher"} is better)`,
    ]
  })
  return renderTable([...headers, "verdict"], withVerdict)
}

export function renderComparisonMarkdown(
  summaries: readonly Summary[],
): string {
  const { headers, rows } = comparisonTable(summaries)
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")
}

/**
 * Compares a run against a committed baseline: the same comparison, across time
 * rather than across topologies. Reports the rows that moved more than
 * `tolerance`, which is the only way a recorded baseline stays honest.
 */
export function drift(
  baseline: Summary,
  current: Summary,
  tolerance = 0.1,
): { label: string; baseline: string; current: string; moved: boolean }[] {
  return KPIS.filter((kpi) => kpi.numeric).map((kpi) => {
    const before = kpi.numeric?.(baseline)
    const after = kpi.numeric?.(current)
    const moved =
      before !== undefined &&
      after !== undefined &&
      before !== 0 &&
      Math.abs(after - before) / Math.abs(before) > tolerance
    return {
      label: kpi.label,
      baseline: kpi.render(baseline),
      current: kpi.render(current),
      moved,
    }
  })
}
