#!/usr/bin/env node
/**
 * Compares runs.
 *
 *   npm run compare 01 02                      # two demos, side by side
 *   npm run compare -- --all                   # every demo, latest run each
 *   npm run compare 01 02 -- --markdown out.md # write the table as markdown
 *   npm run compare 02 -- --against-baseline    # against 02's committed baseline
 *
 * The selectors accept a demo id (`02`), a demo folder name, or a path to a
 * `summary.json`. Exits non-zero when a comparison against a baseline moved more
 * than the tolerance, so a recorded baseline can gate a change.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  drift,
  findSummaries,
  readSummary,
  renderComparison,
  renderComparisonMarkdown,
  renderTable,
  resolveSummary,
} from "../src/index.ts"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const RUNS = `${ROOT}runs`

const argv = process.argv.slice(2)
const selectors = []
let baseline = null
let markdownPath = null
let tolerance = 0.1

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === "--all") continue
  if (arg === "--against-baseline") {
    const next = argv[index + 1]
    // A bare flag resolves to the current study's committed baseline; a `.json`
    // argument is an explicit path.
    if (next?.endsWith(".json")) {
      baseline = next
      index += 1
    } else {
      baseline = "auto"
    }
    continue
  }
  if (arg === "--markdown") {
    markdownPath = argv[index + 1] ?? null
    index += 1
    continue
  }
  if (arg === "--tolerance") {
    tolerance = Number(argv[index + 1] ?? "0.1")
    index += 1
    continue
  }
  selectors.push(arg)
}

if (selectors.length === 0) {
  if (argv.includes("--all")) {
    const latestByDemo = new Map()
    for (const path of findSummaries(RUNS)) {
      const summary = readSummary(path)
      if (!latestByDemo.has(summary.demo)) latestByDemo.set(summary.demo, path)
    }
    selectors.push(...latestByDemo.values())
  } else {
    console.error(
      "usage: compare <demo...> | --all [--markdown path] [--against-baseline [path]]",
    )
    process.exit(2)
  }
}

if (selectors.length === 0) {
  console.error(`no runs under ${RUNS} yet. Run a demo first: npm run demo 01`)
  process.exit(1)
}

const summaries = selectors.map((selector) =>
  readSummary(
    selector.endsWith(".json") ? selector : resolveSummary(RUNS, selector),
  ),
)

console.log(renderComparison(summaries))

if (markdownPath) {
  writeFileSync(markdownPath, `${renderComparisonMarkdown(summaries)}\n`)
  console.log(`\nwrote ${markdownPath}`)
}

if (baseline) {
  const referencePath =
    baseline === "auto"
      ? `${ROOT}case-studies/${summaries[0].demo}/baseline.summary.json`
      : baseline
  const reference = readSummary(referencePath)
  const current = summaries[0]
  const rows = drift(reference, current, tolerance).filter((row) => row.moved)
  console.log(
    `\ndrift vs ${referencePath} (tolerance ${(tolerance * 100).toFixed(0)}%): ` +
      (rows.length === 0 ? "nothing moved" : `${rows.length} KPI(s) moved`),
  )
  if (rows.length > 0) {
    console.log()
    console.log(
      renderTable(
        ["KPI", "baseline", "current"],
        rows.map((row) => [row.label, row.baseline, row.current]),
      ),
    )
    process.exit(1)
  }
}
