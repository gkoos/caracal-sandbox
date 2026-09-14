#!/usr/bin/env node
/**
 * Captures the latest run of a study as its committed baseline.
 *
 *   npm run baseline 02     # runs/<latest 02 run>/summary.json
 *                           #   -> case-studies/02-distributed-basic/baseline.summary.json
 *
 * A baseline is what `compare --against-baseline` diffs against, so capture it
 * from a run you trust - one that passed its checks.
 */
import { copyFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readSummary, resolveSummary } from "caracal-runner"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const id = process.argv[2]

if (!id) {
  console.error("usage: npm run baseline <id>")
  process.exit(2)
}

const source = resolveSummary(`${ROOT}runs`, id)
const summary = readSummary(source)
const passed = summary.checks.filter((check) => check.passed).length
copyFileSync(
  source,
  `${ROOT}case-studies/${summary.demo}/baseline.summary.json`,
)
console.log(
  `baseline captured: ${summary.demo} (${passed}/${summary.checks.length} checks passed)`,
)
