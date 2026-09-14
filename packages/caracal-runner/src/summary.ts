import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { type CheckSpec, runChecks } from "./checks.js"
import type { LatencyMs, Summary, Topology } from "./types.js"

/** Nearest-rank percentile. No interpolation: these are counts, not estimates. */
export function percentile(
  sorted: readonly number[],
  fraction: number,
): number {
  if (sorted.length === 0) return 0
  const index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction),
  )
  return sorted[index] ?? 0
}

export function latency(latencies: readonly number[]): LatencyMs {
  const sorted = [...latencies].sort((left, right) => left - right)
  return {
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
  }
}

export function runId(demo: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("Z", "")
  return `${stamp}_${demo}`
}

export type SummaryInput = {
  demo: string
  title: string
  caracalVersion: string
  caracalSource: string
  topology: Topology
  workload: Summary["workload"]
  client: Summary["client"]
  caracal: Summary["caracal"]
  witness?: Summary["witness"]
  coordination?: Summary["coordination"]
  chaos?: Summary["chaos"]
  notes?: string[]
  startedAt?: string
  finishedAt?: string
}

export function createSummary(input: SummaryInput): Summary {
  const startedAt = input.startedAt ?? new Date().toISOString()
  const summary: Summary = {
    schema: 1,
    runId: runId(input.demo),
    demo: input.demo,
    title: input.title,
    startedAt,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    library: { version: input.caracalVersion, source: input.caracalSource },
    topology: input.topology,
    workload: input.workload,
    client: input.client,
    caracal: input.caracal,
    checks: [],
    passed: false,
    notes: input.notes ?? [],
  }
  if (input.witness) summary.witness = input.witness
  if (input.coordination) summary.coordination = input.coordination
  if (input.chaos) summary.chaos = input.chaos
  // A summary carries its own runId, so the timestamp of creation wins over a
  // caller-supplied start time for naming purposes.
  summary.runId = runId(input.demo, new Date(startedAt))
  return summary
}

/** Attaches check results and the resulting verdict. */
export function finalizeSummary(
  summary: Summary,
  specs: readonly CheckSpec[],
): Summary {
  summary.finishedAt = new Date().toISOString()
  summary.checks = runChecks(summary, specs)
  summary.passed =
    summary.checks.length > 0 && summary.checks.every((check) => check.passed)
  return summary
}

export function writeSummary(directory: string, summary: Summary): string {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "summary.json")
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`)
  return path
}

export function readSummary(path: string): Summary {
  return JSON.parse(readFileSync(path, "utf8")) as Summary
}

/** Every `summary.json` under `root`, newest first. */
export function findSummaries(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries
    .map((entry) => join(root, entry, "summary.json"))
    .filter((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
}

/**
 * Resolves a user-supplied selector to a summary file.
 *
 * Accepts a demo id (`02`), a demo folder name (`02-distributed-basic`), or a
 * path to a `summary.json`. A demo id resolves to its most recent run, which is
 * what makes `npm run compare 01 02` work after the two demos have been run.
 */
export function resolveSummary(root: string, selector: string): string {
  if (selector.endsWith(".json") && !selector.includes("*")) {
    if (!statSync(selector).isFile())
      throw new Error(`no summary at ${selector}`)
    return selector
  }
  const candidates = findSummaries(root).map((path) => ({
    path,
    summary: readSummary(path),
  }))
  // Exact demo name first: a run named `smoke-local-breaker` must not answer a
  // request for `smoke-local` just because it starts with those characters.
  const exact = candidates.find(
    (candidate) => candidate.summary.demo === selector,
  )
  if (exact) return exact.path
  const prefixed = candidates.find((candidate) =>
    candidate.summary.demo.startsWith(`${selector}-`),
  )
  if (!prefixed) {
    throw new Error(
      `no run found for \`${selector}\` under ${root}. Run the demo first (npm run demo ${selector}).`,
    )
  }
  return prefixed.path
}

export function formatMs(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value}ms`
}
