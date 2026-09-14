/**
 * caracal-runner: run manifests, invariant checks and the comparator.
 *
 * A demo is only comparable if it writes the same artifact as every other demo.
 * That artifact is `Summary` (`summary.json`), the claims it must satisfy are
 * entries in `CHECKS` referenced by name, and `compare` is what turns several
 * summaries into the table the demos exist to produce.
 */
export {
  CHECKS,
  type CheckDefinition,
  type CheckParams,
  type CheckSpec,
  checkNames,
  runChecks,
} from "./checks.js"
export {
  type ComparisonTable,
  type Kpi,
  KPIS,
  comparisonTable,
  drift,
  renderComparison,
  renderComparisonMarkdown,
  renderTable,
} from "./compare.js"
export {
  EventSummarizer,
  peakProbesInFlight,
  summarizeEvents,
} from "./events.js"
export { renderReport, writeReport } from "./report.js"
export {
  type SummaryInput,
  createSummary,
  finalizeSummary,
  findSummaries,
  formatMs,
  latency,
  percentile,
  readSummary,
  resolveSummary,
  runId,
  writeSummary,
} from "./summary.js"
export type {
  CaracalView,
  CheckResult,
  ClientView,
  CoordinationView,
  ChaosView,
  LatencyMs,
  Summary,
  Topology,
  WitnessView,
} from "./types.js"
