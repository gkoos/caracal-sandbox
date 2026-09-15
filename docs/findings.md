# Findings

Things the suite taught us, in the order they were found. Each one is either a trap in composing caracal with an OpenTelemetry stack, or a piece of caracal behaviour that reads differently once you can see the numbers.

These are notes for the demos and the documentation, recorded with the evidence that produced them rather than as opinions. Every caracal behaviour below was observed against `@gkoos/caracal@0.4.0`, the version this repository pins.

## 1. A dead collector fails `sdk.shutdown()` (and only that)

Observed while building the M0 smoke, before the stack was running:

```text
otel export failed at shutdown (http://127.0.0.1:4318): connect ECONNREFUSED
```

During a run, failed OTLP exports are swallowed by the SDK's batch processors: the workload is unaffected. At shutdown it is different - `sdk.shutdown()` **rejects** with the transport error, because it force-flushes and the flush is what fails.

The consequence is a deployment trap: an application that awaits its own telemetry shutdown fails its graceful shutdown because a collector is down, which is the wrong way round. `startObservability` absorbs the rejection, counts it in `exportFailures()`, and logs one line. Reproduce the raw behaviour with `npm run diagnose:otel`.

## 2. Metric instruments created before `sdk.start()` are silently permanent no-ops

The first smoke run produced traces in Jaeger and **no metrics at all** in Prometheus. The cause: `CaracalMetrics` created its instruments from the global API before `NodeSDK.start()` registered the meter provider, so every instrument bound to the no-op provider for the life of the process.

The trap is asymmetric, which is why it is worth writing down: `trace.getTracer()` returns a *proxy* that upgrades once a provider is registered, so spans arrive and only the metrics go missing. A run that exports traces but no metrics is this bug, not a collector misconfiguration.

The bridge now creates its telemetry after `start()`, and the ordering is commented where it matters. Demo `05` should turn this into a visible demonstration.

## 3. A saturated bulkhead trips an outer breaker

With the recommended ordering `[breaker, timeout, retry, bulkhead]`, a concurrency of 16 and a bulkhead limit of 8, a smoke run produced:

```text
refused {"bulkhead:capacity":8,"breaker-open":373}
attempts {success:19}   breaker state-changed -> open
```

A bulkhead rejection travelled up to the breaker, where the adapter's classifier (`failure`/`retryable` counts as a failure) recorded it against the dependency. Ten such observations crossed `minimumThroughput`, the breaker opened, and it then shed the rest of the run under a *different* reason.

So under load, the bulkhead's own shedding is what opens the breaker - and the breaker then reports the dependency as unhealthy when the dependency was never the problem.

The fix is the breaker's `classify`, which receives `(error, isSuccess)` and may return `ignored`, so the outcome neither counts toward nor clears failures:

```ts
classify: (error, isSuccess) =>
  error instanceof BulkheadRejectedError
    ? "ignored"
    : isSuccess
      ? "success"
      : "failure"
```

There is no second fix. The alternative that used to be written here - "put the bulkhead outside the breaker, so a rejection short-circuits first" - cannot work: a bulkhead declares `phase: "attempt"`, and the runtime places attempt-phase policies directly around the adapter *whatever their position in the array* ("`phase` decides placement relative to the adapter", `docs/core-api.md`). Array order never moves a bulkhead, so an outer breaker always observes the rejection, and only the classifier changes what it records.

This is a documented default rather than a bug - and it is the right default for a timeout, which really does say something about the dependency. It is the wrong default for a bulkhead, whose rejection means "we shed this on purpose". The sharp edge is that the two look identical to the breaker.

This belongs in demo `01`, where the pipeline itself is the subject.

## 4. Retry inside the breaker dilutes the failure signal

`npm run smoke:breaker` originally injected a 30% per-attempt failure rate and asserted that the breaker would open. It never did. The breaker sits outside retry, so it observes **one outcome per execution**: with two attempts, a 30% per-attempt rate becomes roughly 9% at the level the breaker measures, far below a 50% threshold.

```text
executions {success:288, failure:112}   attempts {success:288, retryable:224}
breaker.rejected 0
```

The execution-level failures are 28% - the retry converted the rest. The point stands: the breaker's view is post-retry, so thresholds have to be chosen against that number, not the per-attempt one. The variant now disables retry, which is also the cleanest way to show the difference.

## 5. `npm run` eats `--flags`, so options travel as environment variables

`npm run smoke -- --no-otel` never reaches the script (npm parses `--no-*` as configuration). Neither does `--otel=off`, silently. Options that survive are a `--flag=value` written *inside* the package.json script, or the environment. The demos therefore pass everything a run needs as `CARACAL_*` and `*_URL` variables.

## 6. Instrument names pass through the collector unchanged

Worth confirming rather than assuming, since a renamed metric is a silently empty panel. With no `unit` set, `caracal_executions_total` arrives in Prometheus as `caracal_executions_total`, and histograms as `caracal_execution_duration_milliseconds_{bucket,count,sum}`. Verified live:

```text
caracal_attempts_total  caracal_bulkhead_occupancy  caracal_executions_total
caracal_retry_scheduled_total  caracal_breaker_observations_total  ...
```

Two follow-ups for the dashboards: a metric that has never been recorded does not exist in Prometheus at all (so a panel is empty until the event happens), and a name that also gained a `_total` or unit suffix would read as a typo in a panel.

## 7. The event stream is enough to reconstruct the invariants

Every check in the runner is computed from events plus the dependency's own numbers - no caracal internals, no test hooks. The smoke already derives attempts and executions by outcome, breaker opens per scope, probe slots in use, rejection reasons per scope, and stale-observation drops. The one thing events cannot see is whether a permit leaked, which is why that check requires the demo to measure it.

## 8. A rejected execution has a one-span trace, and that is correct

The breaker-smoke sample trace:

```text
1 span(s), 0 attempt span(s), 1 policy decision(s) as span events
```

A call the breaker refuses never reaches the adapter, so there is no attempt span - and a trace-shaped "why is this slow" query has to tolerate that. It also means `breaker.rejected` counts and attempt counts diverge by design, not by bug.

## 9. Two operations do not share a budget, because the operation name is part of the identity

The first distributed run of demo 02 measured a witness peak of **10**, not 5, with a shared bulkhead limit of 5. The workload had two operations (`orders.get` and `partner.call`), and each has its own coordination identity:

```text
identity = (namespace, policy name, operation name, scope)
```

Two operations therefore got two shared budgets of 5, and the dependency - which counts them together - saw up to 10. This is not a bug: it is exactly the README's "two operations sharing the same policy instance have separate budgets because their operation names differ". The sharp edge is that a budget meant to protect a *dependency* must live at the granularity of that dependency, which means one operation name (or one scope) per dependency, not one per endpoint.

Demo 02 uses a single operation so "limit 5" maps to the witness directly, and this finding records why.

## 10. Distributed breaker state persists across runs: the namespace must be per-run

The second demo 02 run produced 26 `breaker-open` rejections and three probes, yet `breakerOpens` was 0 and the breaker reported transitions only to `half-open` and `closed`. The "open" state was inherited from the *previous* run: the distributed breaker keeps its state hash in Redis under the namespace, and both runs shared `caracal-demo:02-distributed-basic`, so the fresh run started by reading OPEN and immediately recovering through half-open.

The consequence for anything that re-runs a demo - or re-deploys a service - is that coordination state leaks across runs unless the namespace is unique per run. The orchestrator now uses `caracal-demo:<runId>`, and the demo's own documentation ("use a per-service, per-environment value") is exactly this, discovered rather than assumed.
