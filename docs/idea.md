# The idea: where does the constraint live?

Caracal's claim is narrow and testable:

> A resilience limit only means something where the constrained resource is. Caracal's `scope` is how you say where that is.

Every demo in this repository runs **the same workload against the same dependency** and moves one thing: the coordination boundary. (`03` is the one exception, and says so in its own README: it narrows the scope to a region *and* gives that region its own coordinator, so it moves two.)

```text
01 local-only        boundary = the process
02 distributed-basic boundary = the whole fleet            (scope: global)
03 multi-region      boundary = the region                 (scope: region:${region})
04 tenant-isolation  boundary = the tenant                 (scope: tenant:${tenantId})
05 postgres-permit-hold  boundary = the query              (abort: "unsupported")
06 observability     what every decision looks like once you can see it
07 chaos             does the boundary survive things dying?
```

## The comparison rule: the downstream is the witness

Caracal reports its own decisions through events. Those reports are useful, but they are not evidence: a library that under-counts admissions would happily report success.

So every demo measures its headline claim from two sides where it can:

1. **From the client** - caracal events, mapped to metrics by `caracal-observability`.
2. **From the dependency** - `downstream-mock` counts its own in-flight requests, failures and per-scope concurrency, and exposes them as Prometheus metrics.

Where a demo has a witness for its headline claim, that number is the one that decides whether it passed; the caracal-side number is there to be compared against it, not trusted instead of it. This is the same shape as the soak suite in the library itself ("two independent witnesses"), and it is what makes the headline comparison honest:

```text
4 replicas x bulkhead.local({ limit: 5 })   -> downstream peak 20 concurrent
4 replicas x bulkhead.distributed({ limit: 5, scope: "global" }) -> downstream peak 5
```

## One schema, one dashboard set, one comparator

A demo is not a folder of prose. Each one declares its topology, workload and expected outcome in `study.yaml`, and a run produces `runs/<id>/summary.json` in a single shared schema. From that:

- **Grafana** renders every demo with the same dashboards, so `01` and `02` can be overlaid on one panel instead of compared by memory.
- **`npm run compare 01 02`** prints the KPI table that is the actual point of the demo.
- **invariant checks** decide pass/fail: each one is named, registered, and compares a measured number against a fixed threshold rather than a narrated expectation, so a run that misses its threshold fails the study.

## Caracal/sandbox limitations

- Caracal exposes **events**, not metrics or OpenTelemetry. The bridge in `packages/caracal-observability` is demo glue, written the way a consumer would write it.
- A distributed bulkhead **sheds, it does not queue**. That is the design, and demos show it.
- The PostgreSQL adapter declares `abort: "unsupported"`, so a timed-out query keeps its distributed permit until it settles. Study `05` explains that instead of working around it.
- Leases are not fencing tokens and this is not exactly-once execution. Study `07` shows where that boundary actually is.
