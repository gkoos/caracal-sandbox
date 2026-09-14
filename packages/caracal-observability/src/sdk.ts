import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"
import type { Labels } from "./schema.js"
import { CaracalTelemetry } from "./telemetry.js"

export type ObservabilityOptions = {
  /** Resource `service.name` - what Jaeger and Prometheus group by. */
  serviceName: string
  serviceVersion?: string
  /** OTLP HTTP endpoint. Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT`, then localhost:4318. */
  otlpEndpoint?: string
  /** `CARACAL_OTEL=off` disables export without changing the call sites. */
  enabled?: boolean
  /** Extra resource attributes, for example the replica index. */
  resourceAttributes?: Labels
  /** Metric export interval. Short by default so a demo run is visible live. */
  exportIntervalMillis?: number
  /** Labels added to every metric and span this process emits. */
  baseLabels?: Labels
}

export type Observability = {
  enabled: boolean
  endpoint: string | null
  telemetry: CaracalTelemetry
  /**
   * Exports that failed since start.
   *
   * Worth a number because of a trap in the SDK: export failures *during* a run
   * are swallowed by the batch processors, but `sdk.shutdown()` **rejects** when
   * the collector is unreachable (`connect ECONNREFUSED`). An application that
   * awaits its own telemetry shutdown would therefore fail its graceful shutdown
   * because a collector is down, which is the wrong way round. `shutdown` below
   * absorbs that and counts it instead.
   */
  exportFailures(): number
  shutdown(): Promise<void>
}

export function observabilityEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = (env.CARACAL_OTEL ?? "on").toLowerCase()
  return value !== "off" && value !== "false" && value !== "0"
}

export function otlpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318").replace(
    /\/+$/,
    "",
  )
}

/**
 * Starts the OpenTelemetry SDK and returns the telemetry object to hand to
 * caracal as an event sink.
 *
 * The SDK is started before any instrument is created, because instruments
 * resolved from the global API before a provider is registered are no-ops for
 * the life of the process.
 *
 * When export is disabled the same object is returned with instruments backed by
 * the no-op provider: call sites do not change, and nothing is sent.
 */
export async function startObservability(
  options: ObservabilityOptions,
): Promise<Observability> {
  const enabled = options.enabled ?? observabilityEnabled()
  const endpoint = options.otlpEndpoint ?? otlpEndpoint()
  const resourceAttributes: Labels = {
    "service.name": options.serviceName,
    ...(options.serviceVersion
      ? { "service.version": options.serviceVersion }
      : {}),
    ...options.resourceAttributes,
  }

  let exportFailures = 0
  if (!enabled) {
    // No provider is registered, so everything below is a no-op. Returning the
    // same shape keeps call sites identical whether export is on or off.
    const disabled = new CaracalTelemetry({ baseLabels: options.baseLabels })
    return {
      enabled: false,
      endpoint: null,
      telemetry: disabled,
      exportFailures: () => 0,
      shutdown: async () => {
        disabled.reset()
      },
    }
  }

  const sdk = new NodeSDK({
    resource: defaultResource().merge(
      resourceFromAttributes({ ...resourceAttributes }),
    ),
    // Detectors are off: a demo run should not change shape because of which host
    // it ran on, and the resource attributes above are the ones the panels read.
    autoDetectResources: false,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: options.exportIntervalMillis ?? 2_000,
      }),
    ],
  })
  sdk.start()

  // Deliberately created *after* `start()`: a metric instrument resolved from the
  // global API before a provider is registered stays a no-op for the life of the
  // process, so creating the telemetry first produces a run that looks correct
  // and exports nothing. (Traces are less obvious: the tracer API proxies lazily,
  // so spans still arrive and only the metrics go missing - which is exactly how
  // this was found.)
  const telemetry = new CaracalTelemetry({ baseLabels: options.baseLabels })

  return {
    enabled: true,
    endpoint,
    telemetry,
    exportFailures: () => exportFailures,
    async shutdown() {
      // Any span still open belongs to an execution that never settled; ending
      // them here means they are exported rather than silently dropped.
      telemetry.reset()
      try {
        await sdk.shutdown()
      } catch (error) {
        exportFailures += 1
        console.error(
          `otel export failed at shutdown (${endpoint}): ${(error as Error).message}. ` +
            "Continuing - observability must not decide whether the workload exits cleanly.",
        )
      }
    },
  }
}
