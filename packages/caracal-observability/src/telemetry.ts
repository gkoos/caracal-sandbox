import type { EventSink, OperationEvent } from "@gkoos/caracal"
import { type CaracalMetricsOptions, CaracalMetrics } from "./metrics.js"
import type { Labels } from "./schema.js"
import { CaracalTraces, type CaracalTracesOptions } from "./spans.js"

export type CaracalTelemetryOptions = {
  baseLabels?: Labels
  metrics?: CaracalMetricsOptions
  traces?: CaracalTracesOptions
}

/**
 * The one object a workload hands to caracal as an event sink.
 *
 * Caracal treats sinks as output-only and fire-and-forget, so this class is
 * written to that contract: `emit` is synchronous, never throws, and never
 * awaits anything. Exported telemetry is buffered by the OpenTelemetry SDK and
 * flushed on an interval, so a slow collector delays the export, not the call
 * it describes.
 */
export class CaracalTelemetry {
  readonly metrics: CaracalMetrics
  readonly traces: CaracalTraces

  constructor(options: CaracalTelemetryOptions = {}) {
    this.metrics = new CaracalMetrics({
      baseLabels: options.baseLabels,
      ...options.metrics,
    })
    this.traces = new CaracalTraces({
      baseLabels: options.baseLabels,
      ...options.traces,
    })
  }

  record(event: OperationEvent): void {
    this.metrics.record(event)
    this.traces.record(event)
  }

  /** A sink to pass as `events` (or as one entry of an array of sinks). */
  sink(): EventSink {
    return { emit: (event) => this.record(event) }
  }

  reset(): void {
    this.metrics.reset()
    this.traces.flush()
  }
}
