import { metrics, trace } from "@opentelemetry/api"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { NodeSDK } from "@opentelemetry/sdk-node"

process.on("unhandledRejection", (reason) => {
  console.log("unhandledRejection:", reason)
})
process.on("uncaughtException", (error) => {
  console.log("uncaughtException:", error)
})

const sdk = new NodeSDK({
  autoDetectResources: false,
  traceExporter: new OTLPTraceExporter({
    url: "http://127.0.0.1:4318/v1/traces",
  }),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: "http://127.0.0.1:4318/v1/metrics",
      }),
      exportIntervalMillis: 500,
    }),
  ],
})
sdk.start()
console.log("started")

const counter = metrics.getMeter("probe").createCounter("probe_counter_total")
counter.add(1, { demo: "probe" })

const span = trace.getTracer("probe").startSpan("probe.span")
span.end()
console.log("recorded a metric and a span")

setTimeout(async () => {
  console.log("3s in, awaiting shutdown")
  try {
    await sdk.shutdown()
    console.log("shutdown resolved")
  } catch (error) {
    console.log("shutdown REJECTED:", error?.message ?? error)
  }
  process.exit(0)
}, 3_000)
