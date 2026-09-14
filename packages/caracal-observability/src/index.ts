/**
 * caracal-observability: caracal events to OpenTelemetry traces and metrics.
 *
 * This is demo glue, not part of caracal. The library emits structured events and
 * nothing else, so the mapping from those events onto spans, counters and
 * histograms is written here, in the shape a consumer would write it.
 */
export {
  type CaracalMetricsOptions,
  CaracalMetrics,
} from "./metrics.js"
export {
  type CaracalTracesOptions,
  CaracalTraces,
} from "./spans.js"
export { type CaracalTelemetryOptions, CaracalTelemetry } from "./telemetry.js"
export {
  type Observability,
  type ObservabilityOptions,
  observabilityEnabled,
  otlpEndpoint,
  startObservability,
} from "./sdk.js"
export {
  LABEL,
  type LabelValue,
  type Labels,
  METRIC,
  SPAN,
  definedLabels,
  scopeLabelEnabled,
} from "./schema.js"
export {
  type NdjsonSink,
  type NdjsonSinkOptions,
  asyncSlowSink,
  blockingSink,
  countingSink,
  failingSink,
  ndjsonSink,
} from "./sinks.js"
